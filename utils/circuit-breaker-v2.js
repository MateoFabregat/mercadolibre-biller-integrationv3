/**
 * Circuit Breaker v2
 *
 * Patrón de protección mejorado contra fallos en cascada.
 * Incluye métricas detalladas, eventos y mejor configuración.
 *
 * Estados:
 * - CLOSED: Normal, todas las llamadas pasan
 * - OPEN: Circuito abierto, rechaza llamadas (protección activa)
 * - HALF_OPEN: Probando recuperación, permite algunas llamadas de prueba
 *
 * @module utils/circuit-breaker-v2
 */

const logger = require('./logger');
const EventEmitter = require('events');

/**
 * Estados del circuit breaker
 */
const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Error cuando el circuito está abierto
 */
class CircuitOpenError extends Error {
  constructor(name, message) {
    super(message || `Circuit ${name} is OPEN`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.circuitName = name;
  }
}

/**
 * Circuit Breaker mejorado
 */
class CircuitBreakerV2 extends EventEmitter {
  /**
   * @param {Object} options - Configuración
   * @param {string} options.name - Nombre del circuito
   * @param {number} options.failureThreshold - Fallos para abrir (default: 5)
   * @param {number} options.successThreshold - Éxitos para cerrar desde half-open (default: 2)
   * @param {number} options.timeout - Tiempo en OPEN antes de probar (default: 30000ms)
   * @param {number} options.volumeThreshold - Mínimo de llamadas antes de evaluar (default: 5)
   * @param {number} options.windowDuration - Ventana de tiempo para métricas (default: 60000ms)
   * @param {Function} options.isFailure - Función para determinar si respuesta es fallo
   */
  constructor(options = {}) {
    super();

    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000;
    this.volumeThreshold = options.volumeThreshold || 5;
    this.windowDuration = options.windowDuration || 60000;
    this.isFailure = options.isFailure || ((err) => true);

    // Estado
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.consecutiveSuccesses = 0;
    this.nextAttemptTime = null;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;

    // Métricas en ventana deslizante
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      timeouts: 0,
      latencies: [],
      callsInWindow: []
    };

    // Limpiar métricas antiguas periódicamente
    this.cleanupInterval = setInterval(() => this._cleanupMetrics(), this.windowDuration / 2);

    logger.info(`Circuit breaker '${this.name}' inicializado`, {
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.timeout
    });
  }

  /**
   * Obtiene el estado actual
   * @returns {Object} Estado del circuito
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      consecutiveSuccesses: this.consecutiveSuccesses,
      nextAttemptTime: this.nextAttemptTime,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      isOpen: this.state === STATE.OPEN,
      isClosed: this.state === STATE.CLOSED,
      isHalfOpen: this.state === STATE.HALF_OPEN
    };
  }

  /**
   * Obtiene métricas detalladas
   * @returns {Object} Métricas
   */
  getMetrics() {
    this._cleanupMetrics();

    const callsInWindow = this.metrics.callsInWindow.length;
    const successesInWindow = this.metrics.callsInWindow.filter(c => c.success).length;
    const failuresInWindow = callsInWindow - successesInWindow;

    // Calcular latencias
    const latencies = this.metrics.latencies.slice(-100);
    const avgLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0;
    const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;
    const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 0;

    return {
      state: this.state,
      // Totales históricos
      totalCalls: this.metrics.totalCalls,
      successfulCalls: this.metrics.successfulCalls,
      failedCalls: this.metrics.failedCalls,
      rejectedCalls: this.metrics.rejectedCalls,
      timeouts: this.metrics.timeouts,

      // En ventana actual
      callsInWindow,
      successesInWindow,
      failuresInWindow,
      failureRate: callsInWindow > 0
        ? Math.round((failuresInWindow / callsInWindow) * 100)
        : 0,

      // Latencias
      latency: {
        avg: Math.round(avgLatency),
        p50: Math.round(p50),
        p95: Math.round(p95),
        p99: Math.round(p99)
      }
    };
  }

  /**
   * Verifica si se puede ejecutar una llamada
   * @returns {boolean}
   */
  canExecute() {
    if (this.state === STATE.CLOSED) {
      return true;
    }

    if (this.state === STATE.OPEN) {
      // Verificar si es tiempo de probar
      if (Date.now() >= this.nextAttemptTime) {
        this._transitionTo(STATE.HALF_OPEN);
        return true;
      }
      return false;
    }

    // HALF_OPEN: permitir llamadas de prueba
    return true;
  }

  /**
   * Registra un éxito
   */
  recordSuccess(latency = 0) {
    this.successes++;
    this.consecutiveSuccesses++;
    this.lastSuccessTime = Date.now();
    this.metrics.totalCalls++;
    this.metrics.successfulCalls++;
    this.metrics.latencies.push(latency);
    this.metrics.callsInWindow.push({
      timestamp: Date.now(),
      success: true,
      latency
    });

    if (this.state === STATE.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this._transitionTo(STATE.CLOSED);
      }
    } else if (this.state === STATE.CLOSED) {
      // Reset failures en éxito
      this.failures = 0;
    }
  }

  /**
   * Registra un fallo
   */
  recordFailure(error = null, latency = 0) {
    this.failures++;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = Date.now();
    this.metrics.totalCalls++;
    this.metrics.failedCalls++;
    this.metrics.latencies.push(latency);
    this.metrics.callsInWindow.push({
      timestamp: Date.now(),
      success: false,
      latency,
      error: error?.message
    });

    // Detectar timeout
    if (error && (error.code === 'ETIMEDOUT' || error.message?.includes('timeout'))) {
      this.metrics.timeouts++;
    }

    if (this.state === STATE.HALF_OPEN) {
      // Fallo en prueba: volver a OPEN
      this._transitionTo(STATE.OPEN);
    } else if (this.state === STATE.CLOSED) {
      // Verificar si debemos abrir
      if (this._shouldOpen()) {
        this._transitionTo(STATE.OPEN);
      }
    }
  }

  /**
   * Registra un rechazo (llamada no ejecutada por circuito abierto)
   */
  recordRejection() {
    this.metrics.rejectedCalls++;
  }

  /**
   * Ejecuta una función protegida por el circuit breaker
   * @param {Function} fn - Función a ejecutar
   * @param {*} fallback - Valor de fallback o función
   * @returns {Promise} Resultado
   */
  async execute(fn, fallback = null) {
    if (!this.canExecute()) {
      this.recordRejection();

      if (typeof fallback === 'function') {
        return fallback();
      }
      if (fallback !== null) {
        return fallback;
      }
      throw new CircuitOpenError(this.name);
    }

    const startTime = Date.now();

    try {
      const result = await fn();
      const latency = Date.now() - startTime;
      this.recordSuccess(latency);
      return result;

    } catch (error) {
      const latency = Date.now() - startTime;

      // Verificar si es un fallo que debe contar
      if (this.isFailure(error)) {
        this.recordFailure(error, latency);
      } else {
        // No es un fallo real (ej: validación), contar como éxito
        this.recordSuccess(latency);
      }

      throw error;
    }
  }

  /**
   * Fuerza el circuito a un estado específico (uso administrativo)
   * @param {string} state - Nuevo estado
   */
  forceState(state) {
    if (!Object.values(STATE).includes(state)) {
      throw new Error(`Estado inválido: ${state}`);
    }

    const previousState = this.state;
    this.state = state;

    if (state === STATE.OPEN) {
      this.nextAttemptTime = Date.now() + this.timeout;
    } else if (state === STATE.CLOSED) {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
    }

    logger.warn(`Circuit '${this.name}' forzado: ${previousState} → ${state}`);
    this.emit('forceStateChange', { from: previousState, to: state });
  }

  /**
   * Reinicia el circuit breaker
   */
  reset() {
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.consecutiveSuccesses = 0;
    this.nextAttemptTime = null;

    logger.info(`Circuit '${this.name}' reseteado`);
    this.emit('reset');
  }

  /**
   * Determina si debe abrir el circuito
   * @private
   */
  _shouldOpen() {
    // Verificar volumen mínimo
    this._cleanupMetrics();
    const callsInWindow = this.metrics.callsInWindow.length;

    if (callsInWindow < this.volumeThreshold) {
      return false;
    }

    // Verificar threshold de fallos
    return this.failures >= this.failureThreshold;
  }

  /**
   * Transiciona a un nuevo estado
   * @private
   */
  _transitionTo(newState) {
    const previousState = this.state;
    this.state = newState;

    if (newState === STATE.OPEN) {
      this.nextAttemptTime = Date.now() + this.timeout;
      logger.warn(`Circuit '${this.name}': ${previousState} → OPEN (${this.failures} fallos)`);
    } else if (newState === STATE.HALF_OPEN) {
      this.consecutiveSuccesses = 0;
      logger.info(`Circuit '${this.name}': ${previousState} → HALF_OPEN (probando recuperación)`);
    } else if (newState === STATE.CLOSED) {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
      logger.info(`Circuit '${this.name}': ${previousState} → CLOSED (recuperado)`);
    }

    this.emit('stateChange', { from: previousState, to: newState });
  }

  /**
   * Limpia métricas fuera de la ventana de tiempo
   * @private
   */
  _cleanupMetrics() {
    const cutoff = Date.now() - this.windowDuration;
    this.metrics.callsInWindow = this.metrics.callsInWindow.filter(
      c => c.timestamp > cutoff
    );

    // Mantener solo últimas 100 latencias
    if (this.metrics.latencies.length > 100) {
      this.metrics.latencies = this.metrics.latencies.slice(-100);
    }
  }

  /**
   * Destruye el circuit breaker
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.removeAllListeners();
  }
}

// Factory para crear múltiples circuit breakers
const circuits = new Map();

/**
 * Obtiene o crea un circuit breaker
 * @param {string} name - Nombre del circuito
 * @param {Object} options - Opciones
 * @returns {CircuitBreakerV2}
 */
function getCircuitBreaker(name, options = {}) {
  if (!circuits.has(name)) {
    circuits.set(name, new CircuitBreakerV2({ name, ...options }));
  }
  return circuits.get(name);
}

/**
 * Obtiene todos los circuit breakers
 * @returns {Map}
 */
function getAllCircuits() {
  return circuits;
}

/**
 * Obtiene el estado de todos los circuit breakers
 * @returns {Object}
 */
function getAllCircuitsState() {
  const state = {};
  for (const [name, circuit] of circuits) {
    state[name] = circuit.getState();
  }
  return state;
}

/**
 * Obtiene métricas de todos los circuit breakers
 * @returns {Object}
 */
function getAllCircuitsMetrics() {
  const metrics = {};
  for (const [name, circuit] of circuits) {
    metrics[name] = circuit.getMetrics();
  }
  return metrics;
}

module.exports = {
  CircuitBreakerV2,
  CircuitOpenError,
  STATE,
  getCircuitBreaker,
  getAllCircuits,
  getAllCircuitsState,
  getAllCircuitsMetrics
};
