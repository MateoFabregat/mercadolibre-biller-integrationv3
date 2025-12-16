/**
 * Circuit Breaker para proteger llamadas a APIs externas
 * Evita saturar servicios cuando están caídos
 * @module utils/circuit-breaker
 *
 * @deprecated Usa circuit-breaker-v2.js en su lugar.
 * Esta versión se mantiene por compatibilidad pero será removida en v3.0
 * La versión 2 incluye: métricas en ventana deslizante, eventos, latencias.
 */

const logger = require('./logger');

// Advertencia de deprecación (solo una vez)
let deprecationWarned = false;
function warnDeprecation() {
  if (!deprecationWarned) {
    console.warn('[DEPRECATED] utils/circuit-breaker.js está deprecated. Usa utils/circuit-breaker-v2.js');
    deprecationWarned = true;
  }
}

const STATE = {
  CLOSED: 'CLOSED',     // Normal, permitir llamadas
  OPEN: 'OPEN',         // Fallando, rechazar llamadas
  HALF_OPEN: 'HALF_OPEN' // Probando recuperación
};

class CircuitBreaker {
  /**
   * @param {Object} options
   * @param {string} options.name - Nombre del circuito (para logging)
   * @param {number} options.failureThreshold - Fallos antes de abrir (default: 5)
   * @param {number} options.successThreshold - Éxitos para cerrar en HALF_OPEN (default: 2)
   * @param {number} options.timeout - Tiempo en OPEN antes de probar (ms, default: 30000)
   */
  constructor(options = {}) {
    warnDeprecation();
    this.name = options.name || 'circuit';
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000;
    
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }

  /**
   * Estado actual del circuito
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt
    };
  }

  /**
   * Verificar si se puede ejecutar
   */
  canExecute() {
    if (this.state === STATE.CLOSED) {
      return true;
    }
    
    if (this.state === STATE.OPEN) {
      // Verificar si pasó el timeout
      if (Date.now() >= this.nextAttempt) {
        this.state = STATE.HALF_OPEN;
        this.successes = 0;
        logger.info(`Circuit ${this.name}: OPEN → HALF_OPEN`);
        return true;
      }
      return false;
    }
    
    // HALF_OPEN: permitir una llamada de prueba
    return true;
  }

  /**
   * Registrar éxito
   */
  recordSuccess() {
    this.failures = 0;
    
    if (this.state === STATE.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = STATE.CLOSED;
        logger.info(`Circuit ${this.name}: HALF_OPEN → CLOSED`);
      }
    }
  }

  /**
   * Registrar fallo
   */
  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successes = 0;
    
    if (this.state === STATE.HALF_OPEN) {
      // Volver a OPEN inmediatamente
      this.state = STATE.OPEN;
      this.nextAttempt = Date.now() + this.timeout;
      logger.warn(`Circuit ${this.name}: HALF_OPEN → OPEN (fallo en prueba)`);
    } else if (this.state === STATE.CLOSED && this.failures >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.nextAttempt = Date.now() + this.timeout;
      logger.warn(`Circuit ${this.name}: CLOSED → OPEN (${this.failures} fallos)`);
    }
  }

  /**
   * Ejecutar función protegida por el circuit breaker
   * @param {Function} fn - Función async a ejecutar
   * @param {*} fallback - Valor o función a retornar si el circuito está abierto
   */
  async execute(fn, fallback = null) {
    if (!this.canExecute()) {
      logger.debug(`Circuit ${this.name}: rechazando llamada (OPEN)`);
      
      if (typeof fallback === 'function') {
        return fallback();
      }
      
      if (fallback !== null) {
        return fallback;
      }
      
      throw new CircuitOpenError(`Circuit ${this.name} is OPEN`);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Resetear el circuito manualmente
   */
  reset() {
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    logger.info(`Circuit ${this.name}: reset manual → CLOSED`);
  }
}

/**
 * Error cuando el circuito está abierto
 */
class CircuitOpenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
  }
}

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  STATE
};
