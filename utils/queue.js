/**
 * Sistema de cola para procesamiento de webhooks
 * Con concurrencia limitada, timeout y prioridad
 * @module utils/queue
 */

const logger = require('./logger');

/**
 * Cola de procesamiento asíncrono
 */
class AsyncQueue {
  /**
   * @param {Object} options
   * @param {number} options.concurrency - Máximo de tareas concurrentes
   * @param {number} options.timeout - Timeout por tarea (ms)
   * @param {number} options.maxQueueSize - Máximo de tareas en espera
   */
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.timeout = options.timeout || 60000;
    this.maxQueueSize = options.maxQueueSize || 100;
    
    this.queue = [];
    this.running = 0;
    this.paused = false;
    
    // Métricas
    this.metrics = {
      totalEnqueued: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalTimeout: 0,
      totalDropped: 0
    };
  }

  /**
   * Agregar tarea a la cola
   * @param {Function} task - Función async a ejecutar
   * @param {Object} options - Opciones
   * @param {string} options.id - ID de la tarea
   * @param {number} options.priority - Prioridad (mayor = más urgente)
   * @returns {Promise} - Promesa que resuelve cuando la tarea termine
   */
  enqueue(task, options = {}) {
    return new Promise((resolve, reject) => {
      // Verificar tamaño de cola
      if (this.queue.length >= this.maxQueueSize) {
        this.metrics.totalDropped++;
        logger.warn('Cola llena, descartando tarea', { 
          queueSize: this.queue.length,
          taskId: options.id 
        });
        reject(new Error('Queue is full'));
        return;
      }

      const item = {
        task,
        resolve,
        reject,
        id: options.id || `task-${Date.now()}`,
        priority: options.priority || 0,
        enqueuedAt: Date.now()
      };

      // Insertar según prioridad
      const insertIndex = this.queue.findIndex(q => q.priority < item.priority);
      if (insertIndex === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIndex, 0, item);
      }

      this.metrics.totalEnqueued++;
      
      // Intentar procesar
      this._processNext();
    });
  }

  /**
   * Procesar siguiente tarea de la cola
   */
  async _processNext() {
    if (this.paused) return;
    if (this.running >= this.concurrency) return;
    if (this.queue.length === 0) return;

    const item = this.queue.shift();
    this.running++;

    const startTime = Date.now();
    let timeoutHandle;

    try {
      // Crear promise con timeout
      const result = await Promise.race([
        item.task(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Task ${item.id} timeout after ${this.timeout}ms`));
          }, this.timeout);
        })
      ]);

      clearTimeout(timeoutHandle);
      
      this.metrics.totalProcessed++;
      logger.debug('Tarea completada', { 
        id: item.id, 
        duration: Date.now() - startTime 
      });
      
      item.resolve(result);
      
    } catch (error) {
      clearTimeout(timeoutHandle);
      
      if (error.message.includes('timeout')) {
        this.metrics.totalTimeout++;
      } else {
        this.metrics.totalFailed++;
      }
      
      logger.error('Error en tarea', { 
        id: item.id, 
        error: error.message,
        duration: Date.now() - startTime
      });
      
      item.reject(error);
      
    } finally {
      this.running--;
      // Procesar siguiente
      setImmediate(() => this._processNext());
    }
  }

  /**
   * Pausar procesamiento
   */
  pause() {
    this.paused = true;
    logger.info('Cola pausada');
  }

  /**
   * Reanudar procesamiento
   */
  resume() {
    this.paused = false;
    logger.info('Cola reanudada');
    // Iniciar procesamiento de pendientes
    for (let i = 0; i < this.concurrency; i++) {
      this._processNext();
    }
  }

  /**
   * Limpiar cola
   */
  clear() {
    const dropped = this.queue.length;
    this.queue.forEach(item => {
      item.reject(new Error('Queue cleared'));
    });
    this.queue = [];
    this.metrics.totalDropped += dropped;
    logger.info('Cola limpiada', { dropped });
  }

  /**
   * Obtener estado de la cola
   */
  getStatus() {
    return {
      queued: this.queue.length,
      running: this.running,
      paused: this.paused,
      concurrency: this.concurrency,
      metrics: { ...this.metrics }
    };
  }

  /**
   * Esperar a que la cola esté vacía
   * @param {number} timeout - Timeout máximo (ms)
   */
  async drain(timeout = 30000) {
    const start = Date.now();
    
    while (this.queue.length > 0 || this.running > 0) {
      if (Date.now() - start > timeout) {
        throw new Error('Drain timeout');
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

/**
 * Rate limiter simple basado en tokens
 */
class RateLimiter {
  /**
   * @param {Object} options
   * @param {number} options.tokensPerSecond - Tokens por segundo
   * @param {number} options.bucketSize - Tamaño máximo del bucket
   */
  constructor(options = {}) {
    this.tokensPerSecond = options.tokensPerSecond || 10;
    this.bucketSize = options.bucketSize || options.tokensPerSecond * 2;
    
    this.tokens = this.bucketSize;
    this.lastRefill = Date.now();
  }

  /**
   * Rellenar tokens basado en tiempo transcurrido
   */
  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.tokensPerSecond;
    
    this.tokens = Math.min(this.bucketSize, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Intentar consumir un token
   * @returns {boolean} - true si se pudo consumir
   */
  tryConsume() {
    this._refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    
    return false;
  }

  /**
   * Esperar hasta poder consumir un token
   * @param {number} timeout - Timeout máximo (ms)
   */
  async waitForToken(timeout = 5000) {
    const start = Date.now();
    
    while (!this.tryConsume()) {
      if (Date.now() - start > timeout) {
        throw new Error('Rate limit timeout');
      }
      
      // Calcular tiempo hasta próximo token
      const waitTime = Math.ceil((1 - this.tokens) / this.tokensPerSecond * 1000);
      await new Promise(r => setTimeout(r, Math.min(waitTime, 100)));
    }
  }

  /**
   * Obtener estado del rate limiter
   */
  getStatus() {
    this._refill();
    return {
      tokens: Math.floor(this.tokens),
      bucketSize: this.bucketSize,
      tokensPerSecond: this.tokensPerSecond
    };
  }
}

module.exports = {
  AsyncQueue,
  RateLimiter
};
