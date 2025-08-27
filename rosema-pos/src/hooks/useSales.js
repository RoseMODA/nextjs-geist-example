import { useState, useEffect, useCallback } from 'react';
import {
  processSale,
  getSalesHistory,
  searchSales,
  getSaleById,
  updateSale,
  deleteSale,
  savePendingSale,
  getPendingSale,
  deletePendingSale,
  getSalesStats,
  generateReceiptData
} from '../services/salesService';
import { updateVariantStock, incrementVariantStock } from '../services/productsService';

/**
 * Hook personalizado para gestión de ventas con sesiones completamente independientes
 * Implementa el modelo de SaleSession con aislamiento total entre ventas
 */

// Tipos de pago permitidos
const PAYMENT_METHODS = {
  EFECTIVO: 'Efectivo',
  TRANSFERENCIA: 'Transferencia',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
  QR: 'QR'
};

// Configuración
const MAX_SESSIONS = 6;
const STORAGE_KEY = 'pos.sessions.v1';

/**
 * Generar ID único para sesiones y líneas de productos
 */
const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

/**
 * Crear una nueva sesión vacía
 */
const createEmptySession = (label) => ({
  id: generateId(),
  label: label || `Cliente ${Date.now()}`,
  status: 'open',
  items: [],
  customerId: null,
  customerName: '',
  discountPercent: 0,
  paymentMethod: PAYMENT_METHODS.EFECTIVO,
  cashReceived: 0,
  cardName: '',
  installments: 0,
  commission: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

/**
 * Cargar sesiones desde localStorage
 */
const loadSessionsFromStorage = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      return {
        sessions: data.sessions || {},
        activeSessionId: data.activeSessionId || null
      };
    }
  } catch (error) {
    console.error('Error loading sessions from storage:', error);
  }
  return { sessions: {}, activeSessionId: null };
};

/**
 * Guardar sesiones en localStorage
 */
const saveSessionsToStorage = (sessions, activeSessionId) => {
  try {
    // Solo guardar sesiones abiertas
    const openSessions = Object.fromEntries(
      Object.entries(sessions).filter(([_, session]) => session.status === 'open')
    );
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessions: openSessions,
      activeSessionId: activeSessionId
    }));
  } catch (error) {
    console.error('Error saving sessions to storage:', error);
  }
};

export const useSales = () => {
  // Estado principal de sesiones
  const [salesState, setSalesState] = useState(() => {
    const loaded = loadSessionsFromStorage();
    
    // Si no hay sesiones, crear la primera
    if (Object.keys(loaded.sessions).length === 0) {
      const firstSession = createEmptySession('Cliente 1');
      return {
        sessions: { [firstSession.id]: firstSession },
        activeSessionId: firstSession.id
      };
    }
    
    return {
      sessions: loaded.sessions,
      activeSessionId: loaded.activeSessionId || Object.keys(loaded.sessions)[0]
    };
  });

  // Estados adicionales
  const [salesHistory, setSalesHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Obtener sesión activa
  const getActiveSession = useCallback(() => {
    return salesState.sessions[salesState.activeSessionId] || null;
  }, [salesState]);

  // Función para redondear al múltiplo de 500 más cercano
  const roundToNearest500 = useCallback((amount) => {
    return Math.round(amount / 500) * 500;
  }, []);

  // Calcular totales de una sesión con redondeo a múltiplos de 500
  const calculateSessionTotals = useCallback((session) => {
    if (!session) return { subtotal: 0, discountValue: 0, total: 0, change: 0, itemCount: 0 };
    
    const subtotal = session.items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const discountValue = subtotal * (session.discountPercent / 100);
    const totalBeforeRounding = subtotal - discountValue;
    const total = roundToNearest500(Math.max(0, totalBeforeRounding));
    const change = Math.max(0, session.cashReceived - total);

    return {
      subtotal,
      discountValue,
      total,
      change,
      itemCount: session.items.reduce((sum, item) => sum + item.qty, 0)
    };
  }, [roundToNearest500]);

  // Actualizar estado y persistir
  const updateSalesState = useCallback((updater) => {
    setSalesState(prevState => {
      const newState = typeof updater === 'function' ? updater(prevState) : updater;
      saveSessionsToStorage(newState.sessions, newState.activeSessionId);
      return newState;
    });
  }, []);

  // API del Store - Gestión de sesiones

  /**
   * Crear nueva sesión
   */
  const createSession = useCallback((label) => {
    const sessionCount = Object.keys(salesState.sessions).length;
    if (sessionCount >= MAX_SESSIONS) {
      throw new Error(`Máximo ${MAX_SESSIONS} ventas abiertas permitidas`);
    }

    const newSession = createEmptySession(label || `Cliente ${sessionCount + 1}`);
    
    updateSalesState(prevState => ({
      sessions: {
        ...prevState.sessions,
        [newSession.id]: newSession
      },
      activeSessionId: newSession.id
    }));

    return newSession.id;
  }, [salesState.sessions, updateSalesState]);

  /**
   * Cambiar sesión activa
   */
  const switchSession = useCallback((sessionId) => {
    if (!salesState.sessions[sessionId]) {
      console.error(`Session ${sessionId} not found`);
      return;
    }

    updateSalesState(prevState => ({
      ...prevState,
      activeSessionId: sessionId
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Cancelar sesión
   */
  const cancelSession = useCallback((sessionId) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    // Si tiene items, pedir confirmación
    if (session.items.length > 0) {
      if (!confirm(`¿Estás seguro de cancelar la venta "${session.label}"? Se perderán todos los productos.`)) {
        return;
      }
    }

    updateSalesState(prevState => {
      const newSessions = { ...prevState.sessions };
      delete newSessions[sessionId];
      
      // Si era la sesión activa, cambiar a otra o crear nueva
      let newActiveSessionId = prevState.activeSessionId;
      if (prevState.activeSessionId === sessionId) {
        const remainingIds = Object.keys(newSessions);
        if (remainingIds.length > 0) {
          newActiveSessionId = remainingIds[0];
        } else {
          // Crear nueva sesión si no quedan
          const newSession = createEmptySession('Cliente 1');
          newSessions[newSession.id] = newSession;
          newActiveSessionId = newSession.id;
        }
      }

      return {
        sessions: newSessions,
        activeSessionId: newActiveSessionId
      };
    });
  }, [salesState.sessions, updateSalesState]);

  /**
   * Finalizar sesión (procesar venta)
   */
  const finalizeSession = useCallback(async (sessionId) => {
    const session = salesState.sessions[sessionId];
    if (!session || session.items.length === 0) {
      throw new Error('No hay productos en la venta');
    }

    const totals = calculateSessionTotals(session);
    if (totals.total <= 0) {
      throw new Error('El total debe ser mayor a cero');
    }

    // Validaciones específicas para crédito
    if (session.paymentMethod === PAYMENT_METHODS.CREDITO && !session.cardName.trim()) {
      throw new Error('El nombre de la tarjeta es requerido para pagos con crédito');
    }

    setLoading(true);
    setError(null);

    try {
      const saleData = {
        items: session.items.map(item => ({
          productId: item.productId,
          name: item.nombre || item.name,
          code: item.code,
          price: item.price,
          quantity: item.qty,
          size: item.variant?.talle,
          color: item.variant?.color,
          subtotal: item.price * item.qty,
          isReturn: item.isReturn || false,
          isQuickItem: item.isQuickItem || false
        })),
        paymentMethod: session.paymentMethod,
        discount: totals.discountValue,
        total: totals.total,
        cashReceived: session.cashReceived,
        change: totals.change,
        customerName: session.customerName,
        clientId: sessionId,
        cardName: session.paymentMethod === PAYMENT_METHODS.CREDITO ? session.cardName : null,
        installments: session.paymentMethod === PAYMENT_METHODS.CREDITO ? session.installments : null,
        commission: session.paymentMethod === PAYMENT_METHODS.CREDITO ? session.commission : null
      };

      // Procesar la venta
      const completedSale = await processSale(saleData);
      
      // Actualizar stock de variantes (ventas y devoluciones)
      console.log('🔄 Actualizando stock de variantes...');
      for (const item of session.items) {
        if (item.productId && item.variant && !item.isQuickItem) {
          try {
            if (item.isReturn) {
              // Para devoluciones: incrementar stock
              console.log(`🔄 Incrementando stock para devolución ${item.nombre || item.name}:`, {
                productId: item.productId,
                variant: item.variant,
                quantity: item.qty
              });
              
              await incrementVariantStock(item.productId, item.variant, item.qty);
              console.log(`✅ Stock incrementado para devolución ${item.nombre || item.name}`);
            } else {
              // Para ventas normales: descontar stock
              console.log(`📦 Descontando stock para venta ${item.nombre || item.name}:`, {
                productId: item.productId,
                variant: item.variant,
                quantity: item.qty
              });
              
              await updateVariantStock(item.productId, item.variant, item.qty);
              console.log(`✅ Stock descontado para venta ${item.nombre || item.name}`);
            }
          } catch (stockError) {
            console.error(`❌ Error actualizando stock para ${item.nombre || item.name}:`, stockError);
            // Continuar con otros items aunque uno falle
            // No fallar toda la venta por un error de stock
          }
        }
      }
      
      // Marcar sesión como pagada y remover de abiertas
      updateSalesState(prevState => {
        const newSessions = { ...prevState.sessions };
        delete newSessions[sessionId];
        
        // Si era la sesión activa, cambiar a otra o crear nueva
        let newActiveSessionId = prevState.activeSessionId;
        if (prevState.activeSessionId === sessionId) {
          const remainingIds = Object.keys(newSessions);
          if (remainingIds.length > 0) {
            newActiveSessionId = remainingIds[0];
          } else {
            const newSession = createEmptySession('Cliente 1');
            newSessions[newSession.id] = newSession;
            newActiveSessionId = newSession.id;
          }
        }

        return {
          sessions: newSessions,
          activeSessionId: newActiveSessionId
        };
      });
      
      // Actualizar historial
      setSalesHistory(prev => [completedSale, ...prev]);

      console.log('✅ Venta procesada y stock actualizado exitosamente');
      return completedSale;
    } catch (err) {
      setError(err.message);
      console.error('Error al procesar venta:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [salesState.sessions, calculateSessionTotals, updateSalesState]);

  // API del Store - Gestión de items

  /**
   * Agregar item a sesión
   */
  const addItem = useCallback((sessionId, itemData) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    const lineItem = {
      lineId: generateId(),
      productId: itemData.productId || null,
      name: itemData.name,
      code: itemData.code || null,
      price: itemData.price,
      qty: itemData.quantity || 1,
      variant: {
        talle: itemData.size || null,
        color: itemData.color || null
      },
      stock: itemData.stock || null,
      isReturn: itemData.isReturn || false,
      isQuickItem: itemData.isQuickItem || false
    };

    // Verificar si ya existe un item similar (solo para productos con productId, no para artículos rápidos)
    const existingIndex = !lineItem.isQuickItem && lineItem.productId ? 
      session.items.findIndex(item => 
        item.productId === lineItem.productId &&
        item.variant?.talle === lineItem.variant?.talle &&
        item.variant?.color === lineItem.variant?.color &&
        !item.isReturn &&
        !item.isQuickItem
      ) : -1;

    let newItems;
    if (existingIndex >= 0 && !lineItem.isReturn && !lineItem.isQuickItem) {
      // Actualizar cantidad del item existente (solo para productos regulares)
      newItems = [...session.items];
      newItems[existingIndex] = {
        ...newItems[existingIndex],
        qty: newItems[existingIndex].qty + lineItem.qty
      };
    } else {
      // Agregar nuevo item (siempre para artículos rápidos y devoluciones)
      newItems = [...session.items, lineItem];
    }

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          items: newItems,
          updatedAt: new Date().toISOString()
        }
      }
    }));

    return lineItem.lineId;
  }, [salesState.sessions, updateSalesState]);

  /**
   * Remover item de sesión
   */
  const removeItem = useCallback((sessionId, lineId) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    const newItems = session.items.filter(item => item.lineId !== lineId);

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          items: newItems,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Actualizar cantidad de item
   */
  const updateItemQty = useCallback((sessionId, lineId, qty) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    let newItems;
    if (qty <= 0) {
      newItems = session.items.filter(item => item.lineId !== lineId);
    } else {
      newItems = session.items.map(item => 
        item.lineId === lineId ? { ...item, qty } : item
      );
    }

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          items: newItems,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  // API del Store - Gestión de descuentos y pagos

  /**
   * Aplicar descuento por porcentaje
   */
  const applyDiscountPercent = useCallback((sessionId, percent) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          discountPercent: percent,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Establecer método de pago
   */
  const setPaymentMethod = useCallback((sessionId, method) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          paymentMethod: method,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Establecer efectivo recibido
   */
  const setCashReceived = useCallback((sessionId, amount) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          cashReceived: amount,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Establecer datos del cliente
   */
  const attachCustomer = useCallback((sessionId, customerName) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          customerName: customerName || '',
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Establecer datos de tarjeta de crédito
   */
  const setCreditCardData = useCallback((sessionId, cardName, installments, commission) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: {
          ...session,
          cardName: cardName || '',
          installments: installments || 0,
          commission: commission || 0,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  /**
   * Limpiar sesión
   */
  const clearSession = useCallback((sessionId) => {
    const session = salesState.sessions[sessionId];
    if (!session) return;

    const clearedSession = {
      ...session,
      items: [],
      discountPercent: 0,
      cashReceived: 0,
      customerName: '',
      cardName: '',
      installments: 0,
      commission: 0,
      updatedAt: new Date().toISOString()
    };

    updateSalesState(prevState => ({
      ...prevState,
      sessions: {
        ...prevState.sessions,
        [sessionId]: clearedSession
      }
    }));
  }, [salesState.sessions, updateSalesState]);

  // Funciones de compatibilidad con la API anterior
  const activeSession = getActiveSession();
  const totals = calculateSessionTotals(activeSession);

  // Wrappers para la sesión activa - Actualizado para manejar variantes
  const addToCart = useCallback((product, quantity = 1, variant = null) => {
    if (!salesState.activeSessionId) return;
    
    if (!variant) {
      alert('Debe seleccionar una variante para el producto');
      return;
    }
    
    // Validar stock de la variante
    if (variant.stock < quantity) {
      alert(`Stock insuficiente. Disponible: ${variant.stock}, Solicitado: ${quantity}`);
      return;
    }
    
    return addItem(salesState.activeSessionId, {
      productId: product.id,
      nombre: product.articulo || product.name,  // Usar campo 'articulo'
      code: product.id,                          // Código de barras
      price: variant.precioVenta,
      quantity,
      variant: {
        talle: variant.talle,
        color: variant.color
      },
      stock: variant.stock,
      isReturn: product.isReturn || false,
      isQuickItem: !product.id
    });
  }, [salesState.activeSessionId, addItem]);

  const updateCartItemQuantity = useCallback((lineId, newQuantity) => {
    if (!salesState.activeSessionId) return;
    updateItemQty(salesState.activeSessionId, lineId, newQuantity);
  }, [salesState.activeSessionId, updateItemQty]);

  const removeFromCart = useCallback((lineId) => {
    if (!salesState.activeSessionId) return;
    removeItem(salesState.activeSessionId, lineId);
  }, [salesState.activeSessionId, removeItem]);

  // Funciones adicionales para compatibilidad
  const loadSalesHistory = useCallback(async (filters = {}) => {
    setLoading(true);
    try {
      const history = await getSalesHistory(filters);
      setSalesHistory(history);
      return history;
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    // Estado de sesiones
    sessions: salesState.sessions,
    activeSessionId: salesState.activeSessionId,
    
    // Estado de la sesión activa (para compatibilidad)
    cart: activeSession?.items || [],
    paymentMethod: activeSession?.paymentMethod || PAYMENT_METHODS.EFECTIVO,
    discountPercent: activeSession?.discountPercent || 0,
    cashReceived: activeSession?.cashReceived || 0,
    customerName: activeSession?.customerName || '',
    cardName: activeSession?.cardName || '',
    installments: activeSession?.installments || 0,
    commission: activeSession?.commission || 0,
    totals,
    
    // Estado general
    salesHistory,
    loading,
    error,
    activeClient: salesState.activeSessionId, // Para compatibilidad
    
    // API de sesiones
    createSession,
    switchSession,
    cancelSession,
    finalizeSession,
    addItem,
    removeItem,
    updateItemQty,
    applyDiscountPercent,
    setPaymentMethod: (method) => salesState.activeSessionId && setPaymentMethod(salesState.activeSessionId, method),
    setCashReceived: (amount) => salesState.activeSessionId && setCashReceived(salesState.activeSessionId, amount),
    attachCustomer: (name) => salesState.activeSessionId && attachCustomer(salesState.activeSessionId, name),
    setCreditCardData: (cardName, installments, commission) => salesState.activeSessionId && setCreditCardData(salesState.activeSessionId, cardName, installments, commission),
    clearSession: () => salesState.activeSessionId && clearSession(salesState.activeSessionId),
    
    // Funciones de compatibilidad
    addToCart,
    updateCartItemQuantity,
    removeFromCart,
    completeSale: () => salesState.activeSessionId && finalizeSession(salesState.activeSessionId),
    changeActiveClient: switchSession,
    clearCart: () => salesState.activeSessionId && clearSession(salesState.activeSessionId),
    
    // Setters de compatibilidad
    setDiscountPercent: (percent) => salesState.activeSessionId && applyDiscountPercent(salesState.activeSessionId, percent),
    setCustomerName: (name) => salesState.activeSessionId && attachCustomer(salesState.activeSessionId, name),
    setCardName: (name) => salesState.activeSessionId && setCreditCardData(salesState.activeSessionId, name, activeSession?.installments, activeSession?.commission),
    setInstallments: (installments) => salesState.activeSessionId && setCreditCardData(salesState.activeSessionId, activeSession?.cardName, installments, activeSession?.commission),
    setCommission: (commission) => salesState.activeSessionId && setCreditCardData(salesState.activeSessionId, activeSession?.cardName, activeSession?.installments, commission),
    
    // Funciones adicionales
    loadSalesHistory,
    generateReceipt: generateReceiptData,
    getSalesStatistics: getSalesStats,
    
    // Funciones legacy (mantener para compatibilidad)
    addQuickItem: (itemData) => salesState.activeSessionId && addItem(salesState.activeSessionId, { ...itemData, isQuickItem: true }),
    addReturnItem: (returnData) => salesState.activeSessionId && addItem(salesState.activeSessionId, { 
      ...returnData, 
      isReturn: true, 
      price: -Math.abs(returnData.price), // Precio negativo para restar del total
      qty: returnData.quantity || 1
    }),
    deletePendingSaleData: cancelSession,
    savePendingSaleData: () => Promise.resolve(null), // No necesario con localStorage
    loadPendingSaleData: () => Promise.resolve(null), // No necesario con localStorage
    searchSalesHistory: searchSales,
    deleteSaleFromHistory: deleteSale
  };
};

export default useSales;
