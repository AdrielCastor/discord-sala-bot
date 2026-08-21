const { log } = require('./logger');

class CircuitBreaker {
    constructor(name, { threshold = 5, resetTimeout = 60_000 } = {}) {
        this.name = name;
        this.failures = 0;
        this.threshold = threshold;
        this.resetTimeout = resetTimeout;
        this.state = 'CLOSED';
        this.nextAttempt = 0;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                return null;
            }
            this.state = 'HALF_OPEN';
            log('🟡', `CircuitBreaker [${this.name}]: HALF_OPEN — testando conexão...`);
        }

        try {
            const result = await fn();
            if (this.state !== 'CLOSED') {
                log('🟢', `CircuitBreaker [${this.name}]: FECHADO — operação restaurada.`);
            }
            this.reset();
            return result;
        } catch (err) {
            this.failures++;
            if (this.failures >= this.threshold) {
                this.state = 'OPEN';
                this.nextAttempt = Date.now() + this.resetTimeout;
                log('', `CircuitBreaker [${this.name}]: ABERTO após ${this.failures} falhas. ` +
                    `Próx. tentativa em ${this.resetTimeout / 1000}s.`);
            }
            throw err;
        }
    }

    reset() {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    get isOpen() {
        return this.state === 'OPEN' && Date.now() < this.nextAttempt;
    }
}

module.exports = { CircuitBreaker };
