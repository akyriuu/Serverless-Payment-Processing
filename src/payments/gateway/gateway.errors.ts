export class RetryableGatewayError extends Error { 
    constructor(
        readonly code: string,
        message: string,
    ) { 
        super(message);
        this.name = 'RetryableGatewayError';
    }
}

export class PermanentGatewayError extends Error { 
    constructor(
        readonly code: string,
        message: string,
    ) { 
        super(message);
        this.name = 'PermanentGatewayError';
    }
}