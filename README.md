# Serverless Payment Processing

Asynchronous payment processing built with NestJS on AWS Lambda, featuring a FIFO
queue, bounded retries, a dead letter queue and a transactional outbox.

The point of this project isn't the payment gateway itself — it's the
infrastructure around it: what happens when the network drops mid-charge, when
the same request arrives twice, when the provider authorizes a charge but your
database never records it.

## Architecture

```
Client
  │
  ▼
API Gateway (HTTP API)
  │
  ▼
Lambda: api  ──────────►  PostgreSQL (RDS)
  │                            ▲
  ▼                            │
SQS FIFO ──────────────────────┼──────────► DLQ ──► CloudWatch Alarm
  │                            │
  ▼                            │
Lambda: paymentWorker ─────────┘
  ├──► Payment Gateway
  ├──► S3      (receipts)
  └──► SNS     (domain events)
```

The API does exactly two things: persist the payment as `PENDING` and publish to
the queue. No provider call happens inside the request cycle, so the client gets
a `202 Accepted` in milliseconds and the charge is resolved by the worker.

## Correctness guarantees

These are the decisions the project is built around. Each one addresses a
specific failure mode.

### End-to-end idempotency

Every creation requires an `Idempotency-Key` header, stored in a `@unique`
column. A client retry returns the existing payment instead of creating a second
one. Two concurrent requests carrying the same key collide on the index, and the
`P2002` handler returns the winner of the race rather than surfacing an error.

That same key is replayed to the provider on every charge attempt, so a queue
redelivery cannot produce a double charge.

### Mutual exclusion on consumption

Before touching the gateway, the worker claims the payment with an `updateMany`
guarded by status:

```ts
where: { id, status: { in: [PENDING, PROCESSING] } },
data:  { status: PROCESSING, attemptCount: { increment: 1 } },
```

A `count` of zero means another consumer already owns the payment, and this one
exits without doing anything. Optimistic concurrency control, no explicit locks.

### Never `FAILED` after an authorized charge

The gateway call is the only operation inside the block that can lead to
`FAILED`. Everything after it — settling in the database, publishing the event,
storing the receipt — sits on the other side of that boundary, and a failure
there never reverts the payment status.

Only an explicit provider decline (`PermanentGatewayError`) is allowed to mark a
payment `FAILED`, because it's the only case where we *know* no charge occurred.
Timeouts, network errors and unexpected exceptions leave the payment `PENDING`,
and the message lands in the DLQ once retries are exhausted — a payment with an
unknown outcome needs human review, not an automatic verdict.

### Transactional outbox

Every state transition writes a `PaymentEvent` row **in the same transaction**
that mutates the payment. Publishing to SNS happens afterwards and, on success,
stamps `publishedAt`. If SNS is down, the event stays pending and a sweeper
republishes it.

Delivery is *at least once*: if the publish succeeds but the stamp fails, the
event goes out twice. That's the right trade — losing a payment event is far
worse than delivering it twice. Consumers should treat `paymentId` + `type` as
the deduplication key.

### Receipts off the critical path

The S3 upload happens after settlement and fails silently (with a warning log). A
successful payment without a receipt is discoverable through the
`status: SUCCEEDED, receipt: null` query, ready to be reprocessed.

### Retries and the DLQ

The queue is FIFO with `MessageGroupId` set to the payment id, so a payment being
retried blocks only itself rather than the whole queue.
`MessageDeduplicationId` carries the idempotency key.

The worker replies with `ReportBatchItemFailures`: only failed messages return to
the queue while the rest of the batch is acknowledged. After 5 receives the
message moves to the DLQ, which raises a CloudWatch alarm.

`MAX_ATTEMPTS` acts as an independent safety valve: even if SQS redelivers more
often, the processor refuses to call the gateway beyond the configured limit.

## Data model

| Table | Purpose |
|---|---|
| `Payment` | Current state, `providerRef`, attempt counter |
| `PaymentAttempt` | Per-attempt history with error code and latency |
| `PaymentEvent` | Outbox — domain event and publication timestamp |
| `Receipt` | Pointer to the S3 object, with SHA-256 checksum |

States: `PENDING` → `PROCESSING` → `SUCCEEDED` | `FAILED`.
Methods: `CREDIT_CARD`, `PIX`, `BOLETO`.

## API

```
POST /v1/payments      202 · requires the Idempotency-Key header
GET  /v1/payments      list with filters and cursor pagination
GET  /v1/payments/:id  single payment
```

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 8f14e45f' \
  -d '{"customerId":"cus_1","amountCents":25000,"currency":"BRL","method":"PIX"}'
```

```json
{
  "id": "cmtv65s0a0000y4id0ofdw583",
  "status": "PENDING",
  "amountCents": 25000,
  "currency": "BRL",
  "method": "PIX",
  "attemptCount": 0,
  "providerRef": null
}
```

The list endpoint accepts `customerId`, `status`, `limit` (1–100) and `cursor`.

## Running locally

Requirements: Node 22+, Docker.

```bash
npm install
cp .env.example .env
docker compose up -d
npm run bootstrap:local     # creates queues, topic and bucket in LocalStack
npx prisma migrate dev
```

In separate terminals:

```bash
npm run start:dev      # API on :3000
npm run worker:local   # queue consumer
```

`worker:local` exists because the Lambda event source mapping has no local
equivalent: it long-polls the queue, assembles an `SQSEvent` and calls the very
same `PaymentsWorker` that runs in production, honoring the `batchItemFailures`
contract — a message that fails is not deleted.

The default gateway is `SandboxGateway`, which simulates the real world: 15%
retryable timeouts, 5% hard declines, and a deterministic decline above
1,000,000 cents.

### Inspecting results

```bash
docker exec payments-db psql -U payments -d payments \
  -c 'select id, status, "providerRef", "attemptCount" from "Payment";'

docker exec payments-localstack awslocal s3 ls s3://payments-receipts --recursive
```

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AWS_REGION` | Region for all clients |
| `AWS_ENDPOINT_URL` | Optional; points at LocalStack in development |
| `PAYMENTS_QUEUE_URL` | FIFO queue URL |
| `PAYMENTS_EVENTS_TOPIC_ARN` | SNS topic for domain events |
| `RECEIPTS_BUCKET` | Receipts bucket |
| `MAX_ATTEMPTS` | Charge attempt ceiling (defaults to 3) |

Validated with Zod at startup — a missing variable kills the process on boot, not
on the first request.

## Deployment

```bash
npm run build
npx serverless deploy --stage prod
```

`serverless.yml` provisions the FIFO queue with a redrive policy, the DLQ, the SNS
topic, a versioned and encrypted bucket, the DLQ depth alarm, and both Lambda
functions with least-privilege IAM.

Two build decisions are worth calling out. Packaging uses `tsc` rather than
Serverless v4's built-in esbuild, because esbuild doesn't emit
`emitDecoratorMetadata` and NestJS dependency injection relies on it. And Prisma
runs through a driver adapter (`@prisma/adapter-pg`), which keeps the query
engine binary out of the bundle and shortens cold starts.

In production `DATABASE_URL` should point at an RDS Proxy with
`connection_limit=1` — each Lambda execution environment opens its own pool.

## Layout

```
src/
  aws/          SQS, S3 and SNS adapters
  config/       environment validation with Zod
  lambda/       API and worker handlers
  payments/
    gateway/    provider contract and sandbox implementation
    dto/        input validation and message schema
    *.service   commands
    *.query     reads
    *.processor processing business rules
    *.worker    SQSEvent to processor translation
  prisma/       client and global module
scripts/        local poller and LocalStack bootstrap
```

Splitting `service` (commands) from `query` (reads) is deliberate, as is keeping
`processor` unaware of SQS — it receives an already-validated message and doesn't
know where it came from.

## Current scope

Implemented: full creation and processing flow, idempotency, retries with error
classification, DLQ, S3 receipts, event outbox.

Out of scope so far: API authentication, a real provider integration, a
reconciliation webhook, and the two sweepers that would drain the pending states
the model already accounts for (events with a null `publishedAt`, payments
without a receipt).

## License

MIT

# Processamento de Pagamento Sem Servidor

Processamento assíncrono de pagamentos em NestJS sobre AWS Lambda, com fila FIFO,
retry controlado, dead letter queue e outbox transacional.

O foco do projeto não é o gateway de pagamento em si — é a infraestrutura em volta
dele: o que acontece quando a rede cai no meio de uma cobrança, quando a mesma
requisição chega duas vezes, quando o provider autoriza mas o seu banco não
registra.

## Arquitetura

```
Client
  │
  ▼
API Gateway (HTTP API)
  │
  ▼
Lambda: api  ──────────►  PostgreSQL (RDS)
  │                            ▲
  ▼                            │
SQS FIFO ──────────────────────┼──────────► DLQ ──► CloudWatch Alarm
  │                            │
  ▼                            │
Lambda: paymentWorker ─────────┘
  ├──► Payment Gateway
  ├──► S3      (comprovantes)
  └──► SNS     (eventos de domínio)
```

A API só faz duas coisas: persiste o pagamento como `PENDING` e publica na fila.
Nenhuma chamada ao provider acontece no ciclo da request, então o cliente recebe
`202 Accepted` em milissegundos e a cobrança é resolvida pelo worker.

## Garantias de correção

Estas são as decisões que sustentam o projeto. Cada uma resolve um modo de falha
concreto.

### Idempotência ponta a ponta

Toda criação exige o header `Idempotency-Key`, gravado numa coluna `@unique`.
Retry do cliente devolve o pagamento existente em vez de criar outro. Duas
requisições simultâneas com a mesma chave colidem no índice, e o handler do erro
`P2002` devolve o vencedor da corrida em vez de propagar o erro.

A mesma chave é reenviada ao provider a cada tentativa de cobrança, então uma
redelivery da fila não gera cobrança dupla.

### Exclusão mútua no consumo

Antes de tocar no gateway, o worker reivindica o pagamento com um `updateMany`
que filtra por status:

```ts
where: { id, status: { in: [PENDING, PROCESSING] } },
data:  { status: PROCESSING, attemptCount: { increment: 1 } },
```

Se o `count` voltar zero, outro consumidor já pegou o pagamento e este sai sem
fazer nada. É controle de concorrência otimista sem lock explícito.

### Nenhum `FAILED` depois de cobrança autorizada

A chamada ao gateway é a única operação dentro do bloco que pode levar a
`FAILED`. Tudo que vem depois — liquidar no banco, publicar evento, gravar
comprovante — está do outro lado dessa fronteira, e falha ali nunca reverte o
status do pagamento.

Só uma recusa explícita do provider (`PermanentGatewayError`) autoriza marcar
`FAILED`, porque é o único caso em que se *sabe* que não houve cobrança. Timeout,
erro de rede ou exceção inesperada mantêm o pagamento em `PENDING`, e a mensagem
segue para a DLQ depois de esgotar as tentativas — um pagamento de desfecho
incerto precisa de revisão humana, não de conclusão automática.

### Outbox transacional

Cada transição de estado grava uma linha em `PaymentEvent` **na mesma transação**
que altera o pagamento. A publicação no SNS acontece depois e, se der certo,
marca `publishedAt`. Se o SNS estiver fora, o evento fica pendente e um sweeper
republica.

A entrega é *pelo menos uma vez*: se a publicação funcionar mas a marcação
falhar, o evento sai duplicado. É a troca correta — perder evento de pagamento é
pior do que entregar duas vezes. Consumidores devem tratar `paymentId` + `type`
como chave de deduplicação.

### Comprovante fora do caminho crítico

O upload para o S3 acontece depois da liquidação e falha em silêncio (com log de
warning). Um pagamento bem-sucedido sem comprovante fica visível na consulta
`status: SUCCEEDED, receipt: null`, pronto para reprocessamento.

### Retry e DLQ

A fila é FIFO com `MessageGroupId` igual ao id do pagamento, então um pagamento em
retry bloqueia apenas a si próprio, e não a fila inteira. `MessageDeduplicationId`
usa a chave de idempotência.

O worker responde com `ReportBatchItemFailures`: apenas as mensagens que falharam
voltam para a fila, e o resto do lote é confirmado. Depois de 5 recebimentos, a
mensagem vai para a DLQ, que dispara um alarme no CloudWatch.

O `MAX_ATTEMPTS` é uma trava independente: mesmo que o SQS redelivere mais vezes,
o processor recusa chamar o gateway acima do limite configurado.

## Modelo de dados

| Tabela | Papel |
|---|---|
| `Payment` | Estado corrente, `providerRef`, contador de tentativas |
| `PaymentAttempt` | Histórico de cada tentativa, com código de erro e latência |
| `PaymentEvent` | Outbox — evento de domínio e o instante da publicação |
| `Receipt` | Ponteiro para o comprovante no S3, com checksum SHA-256 |

Estados: `PENDING` → `PROCESSING` → `SUCCEEDED` | `FAILED`.
Métodos: `CREDIT_CARD`, `PIX`, `BOLETO`.

## API

```
POST /v1/payments      201/202 · exige header Idempotency-Key
GET  /v1/payments      lista com filtros e cursor
GET  /v1/payments/:id  consulta unitária
```

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 8f14e45f' \
  -d '{"customerId":"cus_1","amountCents":25000,"currency":"BRL","method":"PIX"}'
```

```json
{
  "id": "cmtv65s0a0000y4id0ofdw583",
  "status": "PENDING",
  "amountCents": 25000,
  "currency": "BRL",
  "method": "PIX",
  "attemptCount": 0,
  "providerRef": null
}
```

A listagem aceita `customerId`, `status`, `limit` (1–100) e `cursor` para
paginação por cursor.

## Rodando localmente

Requisitos: Node 22+, Docker.

```bash
npm install
cp .env.example .env
docker compose up -d
npm run bootstrap:local     # cria filas, tópico e bucket no LocalStack
npx prisma migrate dev
```

Em terminais separados:

```bash
npm run start:dev      # API em :3000
npm run worker:local   # consumidor da fila
```

O `worker:local` existe porque o event source mapping do Lambda não tem
equivalente local: ele faz long polling na fila, monta um `SQSEvent` e chama o
mesmo `PaymentsWorker` que roda em produção, respeitando o contrato de
`batchItemFailures` — mensagem que falha não é deletada.

O gateway padrão é o `SandboxGateway`, que simula o mundo real: 15% de timeout
retryable, 5% de recusa permanente, e recusa determinística acima de R$ 10.000.

### Inspecionando o resultado

```bash
docker exec payments-db psql -U payments -d payments \
  -c 'select id, status, "providerRef", "attemptCount" from "Payment";'

docker exec payments-localstack awslocal s3 ls s3://payments-receipts --recursive
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL |
| `AWS_REGION` | Região dos clients |
| `AWS_ENDPOINT_URL` | Opcional; aponta para o LocalStack em desenvolvimento |
| `PAYMENTS_QUEUE_URL` | URL da fila FIFO |
| `PAYMENTS_EVENTS_TOPIC_ARN` | Tópico SNS de eventos |
| `RECEIPTS_BUCKET` | Bucket dos comprovantes |
| `MAX_ATTEMPTS` | Teto de tentativas de cobrança (padrão 3) |

Validadas com Zod na inicialização — variável faltando derruba o processo no
start, não na primeira requisição.

## Deploy

```bash
npm run build
npx serverless deploy --stage prod
```

O `serverless.yml` provisiona a fila FIFO com redrive, a DLQ, o tópico SNS, o
bucket versionado e criptografado, o alarme de profundidade da DLQ e as duas
funções Lambda com IAM de menor privilégio.

Duas decisões de build valem nota. O empacotamento usa `tsc` em vez do esbuild
nativo do Serverless v4, porque o esbuild não emite `emitDecoratorMetadata` e a
injeção de dependência do NestJS depende desse metadata. E o Prisma roda com
driver adapter (`@prisma/adapter-pg`), o que elimina o binário do query engine do
bundle e reduz o cold start.

Em produção, o `DATABASE_URL` deve apontar para um RDS Proxy com
`connection_limit=1` — cada execution environment do Lambda abre o próprio pool.

## Estrutura

```
src/
  aws/          adapters de SQS, S3 e SNS
  config/       validação de ambiente com Zod
  lambda/       handlers de API e worker
  payments/
    gateway/    contrato do provider e implementação sandbox
    dto/        validação de entrada e schema das mensagens
    *.service   comandos
    *.query     consultas
    *.processor regra de negócio do processamento
    *.worker    tradução de SQSEvent para o processor
  prisma/       client e módulo global
scripts/        poller local e bootstrap do LocalStack
```

A separação entre `service` (comandos) e `query` (consultas) é deliberada, assim
como manter o `processor` sem conhecimento de SQS — ele recebe uma mensagem já
validada e não sabe de onde veio.

## Escopo atual

Implementado: fluxo completo de criação e processamento, idempotência, retry com
classificação de erro, DLQ, comprovantes em S3, outbox de eventos.

Fora do escopo até aqui: autenticação na API, integração com um provider real,
webhook de reconciliação, e os dois sweepers que consomem os estados pendentes
que o modelo já prevê (eventos com `publishedAt` nulo, pagamentos sem
comprovante).

## Licença

MIT