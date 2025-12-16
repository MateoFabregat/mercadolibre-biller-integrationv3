/**
 * Sistema de reintentos con backoff exponencial
 * @module utils/retry
 */

const logger = require('./logger');

/**
 * Esperar un tiempo determinado
 * @param {number} ms - Milisegundos a esperar
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calcular delay con backoff exponencial y jitter
 * @param {number} attempt - Número de intento (0-based)
 * @param {number} initialDelay - Delay inicial en ms
 * @param {number} maxDelay - Delay máximo en ms
 * @param {number} factor - Factor de multiplicación
 */
function calculateBackoff(attempt, initialDelay, maxDelay, factor = 2) {
  const exponentialDelay = initialDelay * Math.pow(factor, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  
  // Agregar jitter (±25%) para evitar thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  
  return Math.round(cappedDelay + jitter);
}

/**
 * Errores que NO deben reintentarse
 */
const NON_RETRYABLE_ERRORS = [
  'VALIDATION_ERROR',
  'INVALID_TOKEN',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'DUPLICATE'
];

/**
 * Determinar si un error es retriable
 * @param {Error} error
 */
function isRetryable(error) {
  // Errores de red siempre son retriables
  if (error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' || 
      error.code === 'ENOTFOUND') {
    return true;
  }
  
  // HTTP 5xx son retriables
  if (error.status >= 500) {
    return true;
  }
  
  // HTTP 429 (rate limit) es retriable
  if (error.status === 429) {
    return true;
  }
  
  // Verificar errores no retriables
  if (error.code && NON_RETRYABLE_ERRORS.includes(error.code)) {
    return false;
  }
  
  // HTTP 4xx (excepto 429) no son retriables
  if (error.status >= 400 && error.status < 500) {
    return false;
  }
  
  // Por defecto, reintentar
  return true;
}

/**
 * Ejecutar función con reintentos
 * @param {Function} fn - Función async a ejecutar
 * @param {Object} options - Opciones
 * @param {number} options.maxAttempts - Máximo de intentos
 * @param {number} options.initialDelay - Delay inicial en ms
 * @param {number} options.maxDelay - Delay máximo en ms
 * @param {string} options.operationName - Nombre de la operación para logging
 * @param {Function} options.onRetry - Callback en cada reintento
 */
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    operationName = 'operation',
    onRetry = null
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Verificar si es retriable
      if (!isRetryable(error)) {
        logger.debug(`Error no retriable en ${operationName}`, { 
          error: error.message,
          status: error.status 
        });
        throw error;
      }
      
      // Si es el último intento, no esperar
      if (attempt === maxAttempts - 1) {
        break;
      }
      
      // Calcular delay
      const delay = calculateBackoff(attempt, initialDelay, maxDelay);
      
      logger.warn(`Reintentando ${operationName}`, {
        attempt: attempt + 1,
        maxAttempts,
        delay,
        error: error.message
      });
      
      // Callback de reintento
      if (onRetry) {
        onRetry(attempt + 1, delay, error);
      }
      
      await sleep(delay);
    }
  }
  
  // Todos los intentos fallaron
  logger.error(`${operationName} falló después de ${maxAttempts} intentos`, {
    error: lastError.message
  });
  
  throw lastError;
}

/**
 * Crear wrapper con retry preconfigurado
 * @param {Object} defaultOptions - Opciones por defecto
 */
function createRetryWrapper(defaultOptions) {
  return (fn, operationName) => withRetry(fn, { ...defaultOptions, operationName });
}

module.exports = {
  withRetry,
  createRetryWrapper,
  sleep,
  isRetryable,
  calculateBackoff
};
