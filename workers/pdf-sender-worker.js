/**
 * PDF Sender Worker
 *
 * Worker para envío asíncrono de PDFs de comprobantes.
 * Procesa envíos en segundo plano sin bloquear el flujo principal.
 *
 * @module workers/pdf-sender-worker
 */

const logger = require('../utils/logger');

/**
 * Cola de envíos pendientes
 */
class PDFSenderQueue {
  constructor(options = {}) {
    this.billerClient = options.billerClient || null;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 5000; // 5 segundos
    this.concurrency = options.concurrency || 2;

    this.queue = [];
    this.processing = 0;
    this.stats = {
      enqueued: 0,
      sent: 0,
      failed: 0,
      retried: 0
    };

    this.isRunning = false;

    logger.info('PDFSenderWorker inicializado', {
      maxRetries: this.maxRetries,
      concurrency: this.concurrency
    });
  }

  /**
   * Configura el cliente de Biller
   */
  configure(options) {
    if (options.billerClient) {
      this.billerClient = options.billerClient;
    }
  }

  /**
   * Encola un envío de PDF
   * @param {Object} params - Parámetros del envío
   * @returns {string} ID del job
   */
  enqueue(params) {
    const job = {
      id: this._generateId(),
      comprobanteId: params.comprobanteId,
      email: params.email,
      orderId: params.orderId,
      orderName: params.orderName,
      attempts: 0,
      createdAt: Date.now(),
      status: 'pending'
    };

    this.queue.push(job);
    this.stats.enqueued++;

    logger.debug(`PDF encolado para envío: ${job.id}`, {
      comprobanteId: job.comprobanteId,
      email: job.email
    });

    // Iniciar procesamiento si no está corriendo
    this._processNext();

    return job.id;
  }

  /**
   * Procesa el siguiente job en la cola
   * @private
   */
  async _processNext() {
    // Verificar límite de concurrencia
    if (this.processing >= this.concurrency) {
      return;
    }

    // Obtener siguiente job pendiente
    const job = this.queue.find(j => j.status === 'pending');
    if (!job) {
      return;
    }

    // Marcar como procesando
    job.status = 'processing';
    this.processing++;

    try {
      await this._sendPDF(job);
      job.status = 'completed';
      this.stats.sent++;

      logger.info(`✅ PDF enviado exitosamente`, {
        jobId: job.id,
        comprobanteId: job.comprobanteId,
        email: job.email
      });

    } catch (error) {
      job.attempts++;

      if (job.attempts < this.maxRetries) {
        // Reintentar
        job.status = 'pending';
        job.nextRetry = Date.now() + (this.retryDelay * job.attempts);
        this.stats.retried++;

        logger.warn(`Reintentando envío de PDF`, {
          jobId: job.id,
          attempt: job.attempts,
          error: error.message
        });

        // Programar reintento
        setTimeout(() => this._processNext(), this.retryDelay * job.attempts);

      } else {
        // Fallo definitivo
        job.status = 'failed';
        job.error = error.message;
        this.stats.failed++;

        logger.error(`❌ Fallo enviando PDF después de ${this.maxRetries} intentos`, {
          jobId: job.id,
          comprobanteId: job.comprobanteId,
          error: error.message
        });
      }

    } finally {
      this.processing--;

      // Continuar con siguiente
      setImmediate(() => this._processNext());
    }
  }

  /**
   * Envía el PDF de un comprobante
   * @private
   */
  async _sendPDF(job) {
    if (!this.billerClient) {
      throw new Error('BillerClient no configurado');
    }

    // Enviar comprobante por email usando Biller
    await this.billerClient.enviarComprobantePorEmail(job.comprobanteId, job.email);
  }

  /**
   * Obtiene el estado de un job
   * @param {string} jobId - ID del job
   * @returns {Object|null} Estado del job
   */
  getJobStatus(jobId) {
    const job = this.queue.find(j => j.id === jobId);
    if (!job) return null;

    return {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      createdAt: new Date(job.createdAt).toISOString(),
      error: job.error || null
    };
  }

  /**
   * Obtiene estadísticas del worker
   * @returns {Object} Estadísticas
   */
  getStats() {
    const pendingJobs = this.queue.filter(j => j.status === 'pending').length;
    const processingJobs = this.queue.filter(j => j.status === 'processing').length;
    const completedJobs = this.queue.filter(j => j.status === 'completed').length;
    const failedJobs = this.queue.filter(j => j.status === 'failed').length;

    return {
      ...this.stats,
      queueSize: this.queue.length,
      pending: pendingJobs,
      processing: processingJobs,
      completed: completedJobs,
      failed: failedJobs,
      successRate: this.stats.enqueued > 0
        ? Math.round((this.stats.sent / this.stats.enqueued) * 100)
        : 100
    };
  }

  /**
   * Limpia jobs completados y fallidos antiguos
   * @param {number} maxAge - Edad máxima en ms
   */
  cleanup(maxAge = 3600000) { // 1 hora por defecto
    const cutoff = Date.now() - maxAge;

    this.queue = this.queue.filter(job => {
      if (job.status === 'pending' || job.status === 'processing') {
        return true;
      }
      return job.createdAt > cutoff;
    });
  }

  /**
   * Obtiene jobs fallidos
   * @returns {Array} Jobs fallidos
   */
  getFailedJobs() {
    return this.queue
      .filter(j => j.status === 'failed')
      .map(j => ({
        id: j.id,
        comprobanteId: j.comprobanteId,
        email: j.email,
        orderId: j.orderId,
        attempts: j.attempts,
        error: j.error,
        createdAt: new Date(j.createdAt).toISOString()
      }));
  }

  /**
   * Reintenta un job fallido
   * @param {string} jobId - ID del job
   * @returns {boolean} true si se reinició
   */
  retryJob(jobId) {
    const job = this.queue.find(j => j.id === jobId && j.status === 'failed');
    if (!job) return false;

    job.status = 'pending';
    job.attempts = 0;
    job.error = null;

    this._processNext();
    return true;
  }

  /**
   * Genera ID único
   * @private
   */
  _generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `pdf-${timestamp}-${random}`;
  }
}

// Singleton
let instance = null;

function getPDFSenderWorker(options = {}) {
  if (!instance) {
    instance = new PDFSenderQueue(options);
  }
  return instance;
}

module.exports = {
  PDFSenderQueue,
  getPDFSenderWorker
};
