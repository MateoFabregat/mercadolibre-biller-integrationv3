/**
 * Biller Search Cache
 *
 * Cache en memoria para búsquedas en Biller.
 * Reduce latencia y carga en la API de Biller.
 *
 * @module utils/biller-search-cache
 */

const logger = require('./logger');

/**
 * Clase para cachear búsquedas de Biller
 */
class BillerSearchCache {
  /**
   * @param {Object} options - Configuración
   * @param {number} options.ttl - Tiempo de vida en ms (default: 5 minutos)
   * @param {number} options.maxSize - Máximo de entradas (default: 1000)
   * @param {number} options.cleanupInterval - Intervalo de limpieza (default: 60s)
   */
  constructor(options = {}) {
    this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutos
    this.maxSize = options.maxSize || 1000;
    this.cleanupInterval = options.cleanupInterval || 60000;

    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0
    };

    // Limpieza periódica
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupInterval);

    logger.debug('BillerSearchCache inicializado', {
      ttl: this.ttl,
      maxSize: this.maxSize
    });
  }

  /**
   * Genera una clave de cache
   * @param {string} type - Tipo de búsqueda
   * @param {string} key - Identificador
   * @returns {string} Clave de cache
   */
  _generateKey(type, key) {
    return `${type}:${key}`;
  }

  /**
   * Obtiene un valor del cache
   * @param {string} type - Tipo de búsqueda (ej: 'comprobante', 'numero_interno')
   * @param {string} key - Identificador
   * @returns {*} Valor cacheado o null
   */
  get(type, key) {
    const cacheKey = this._generateKey(type, key);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Verificar expiración
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    entry.hits++;
    entry.lastAccess = Date.now();

    return entry.value;
  }

  /**
   * Guarda un valor en el cache
   * @param {string} type - Tipo de búsqueda
   * @param {string} key - Identificador
   * @param {*} value - Valor a cachear
   * @param {number} customTtl - TTL personalizado (opcional)
   */
  set(type, key, value, customTtl = null) {
    const cacheKey = this._generateKey(type, key);
    const ttl = customTtl || this.ttl;

    // Eviction si excede tamaño
    if (this.cache.size >= this.maxSize && !this.cache.has(cacheKey)) {
      this._evictOne();
    }

    this.cache.set(cacheKey, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      lastAccess: Date.now(),
      hits: 0
    });

    this.stats.sets++;
  }

  /**
   * Invalida una entrada del cache
   * @param {string} type - Tipo de búsqueda
   * @param {string} key - Identificador
   * @returns {boolean} true si se invalidó
   */
  invalidate(type, key) {
    const cacheKey = this._generateKey(type, key);
    return this.cache.delete(cacheKey);
  }

  /**
   * Invalida todas las entradas de un tipo
   * @param {string} type - Tipo de búsqueda
   * @returns {number} Cantidad de entradas invalidadas
   */
  invalidateType(type) {
    const prefix = `${type}:`;
    let count = 0;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Limpia todo el cache
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    logger.debug(`BillerSearchCache: ${size} entradas limpiadas`);
  }

  /**
   * Obtiene o calcula un valor (cache-aside pattern)
   * @param {string} type - Tipo de búsqueda
   * @param {string} key - Identificador
   * @param {Function} fetchFn - Función para obtener el valor si no está en cache
   * @param {number} customTtl - TTL personalizado (opcional)
   * @returns {*} Valor
   */
  async getOrFetch(type, key, fetchFn, customTtl = null) {
    // Intentar obtener del cache
    const cached = this.get(type, key);
    if (cached !== null) {
      return cached;
    }

    // Ejecutar función de búsqueda
    try {
      const value = await fetchFn();

      // Solo cachear si hay valor
      if (value !== null && value !== undefined) {
        this.set(type, key, value, customTtl);
      }

      return value;

    } catch (error) {
      // No cachear errores
      throw error;
    }
  }

  /**
   * Obtiene estadísticas del cache
   * @returns {Object} Estadísticas
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;

    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: totalRequests > 0
        ? Math.round((this.stats.hits / totalRequests) * 100)
        : 0,
      memoryUsage: this._estimateMemoryUsage()
    };
  }

  /**
   * Evicta la entrada menos usada
   * @private
   */
  _evictOne() {
    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Limpia entradas expiradas
   * @private
   */
  _cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`BillerSearchCache: ${cleaned} entradas expiradas limpiadas`);
    }
  }

  /**
   * Estima uso de memoria
   * @private
   */
  _estimateMemoryUsage() {
    let bytes = 0;

    for (const [key, entry] of this.cache) {
      bytes += key.length * 2; // String en UTF-16
      bytes += JSON.stringify(entry.value).length * 2;
      bytes += 100; // Overhead del objeto entry
    }

    return {
      bytes,
      kb: Math.round(bytes / 1024),
      mb: Math.round(bytes / 1024 / 1024 * 100) / 100
    };
  }

  /**
   * Detiene el cache
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Singleton
let instance = null;

function getBillerSearchCache(options = {}) {
  if (!instance) {
    instance = new BillerSearchCache(options);
  }
  return instance;
}

module.exports = {
  BillerSearchCache,
  getBillerSearchCache
};
