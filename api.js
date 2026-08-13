// ============================================================
// BANTOG ISP — API Layer with Offline Support
// ============================================================
// Replace API_URL with your deployed Apps Script web app URL
// ============================================================

const API_URL = 'https://script.google.com/macros/s/AKfycbwsZq13QZHLaklJvCcOoShyhc6dPE4NQWYo33gO2qqI_5JoCFraFani4CkmX1yMHKLNOQ/exec';

// Debug mode — set to true to see detailed logs in console
const DEBUG = true;

function debugLog(...args) {
  if (DEBUG) console.log('[BantogISP]', ...args);
}

// ==================== IndexedDB Setup ====================

const DB_NAME = 'BantogISP';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('clients')) {
        const clientStore = db.createObjectStore('clients', { keyPath: 'username' });
        clientStore.createIndex('status', 'status', { unique: false });
        clientStore.createIndex('clientName', 'clientName', { unique: false });
      }

      if (!db.objectStoreNames.contains('pendingActions')) {
        const pendingStore = db.createObjectStore('pendingActions', { keyPath: 'id', autoIncrement: true });
        pendingStore.createIndex('timestamp', 'timestamp', { unique: false });
        pendingStore.createIndex('type', 'type', { unique: false });
      }

      if (!db.objectStoreNames.contains('summary')) {
        db.createObjectStore('summary', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ==================== IndexedDB Helpers ====================

function dbPut(storeName, data) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function dbGet(storeName, key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function dbGetAll(storeName) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function dbDelete(storeName, key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

function dbClear(storeName) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

// ==================== Network Check ====================

function isOnline() {
  return navigator.onLine;
}

// ==================== API Functions ====================

// Robust fetch for Google Apps Script (handles redirects)
async function fetchGAS(url, options = {}) {
  debugLog('Fetching:', url.substring(0, 100) + '...');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText);
    }

    const text = await response.text();
    debugLog('Response preview:', text.substring(0, 200));

    try {
      return JSON.parse(text);
    } catch (e) {
      debugLog('JSON parse failed, raw text:', text.substring(0, 500));
      throw new Error('Invalid JSON response from server');
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out (20s)');
    }
    throw err;
  }
}

// ---- Sync all clients to local DB ----
async function syncClientsFromServer() {
  if (!isOnline()) {
    debugLog('Offline — skipping server sync');
    return { success: false, reason: 'offline' };
  }

  try {
    const url = API_URL + '?action=allClients';
    debugLog('Syncing all clients from server...');

    const clients = await fetchGAS(url);

    if (!Array.isArray(clients)) {
      debugLog('Expected array, got:', typeof clients);
      return { success: false, reason: 'invalid_response', data: clients };
    }

    debugLog('Received', clients.length, 'clients from server');

    // Save to IndexedDB
    await dbClear('clients');
    let saved = 0;
    for (const client of clients) {
      if (client.username) {
        await dbPut('clients', client);
        saved++;
      }
    }

    await dbPut('meta', { key: 'lastSync', value: new Date().toISOString() });
    debugLog('Saved', saved, 'clients to local DB');
    return { success: true, count: saved };

  } catch (err) {
    debugLog('Sync failed:', err.message);
    return { success: false, reason: err.message };
  }
}

// ---- Get summary (online or offline) ----
async function getSummary() {
  if (isOnline()) {
    try {
      const url = API_URL + '?action=summary';
      const data = await fetchGAS(url);
      await dbPut('summary', { id: 'current', ...data });
      debugLog('Summary from server:', data);
      return data;
    } catch (err) {
      debugLog('Online summary failed, using local:', err.message);
    }
  }

  const cached = await dbGet('summary', 'current');
  if (cached) return cached;

  return computeSummaryFromLocal();
}

async function computeSummaryFromLocal() {
  const clients = await dbGetAll('clients');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const DUE_SOON_DAYS = 7;

  let dueToday = 0, dueSoon = 0, pastDue = 0, totalCollected = 0;
  let paidCount = 0, toCollectCount = 0, totalClients = 0;

  for (const c of clients) {
    const prevBalance = c.prevBalance || 0;
    const totalDue = (c.amountDue || 0) + prevBalance;
    const balance = totalDue - (c.amountPaid || 0);
    totalClients++;
    totalCollected += c.amountPaid || 0;

    if (balance <= 0) {
      paidCount++;
      continue;
    }

    if (c.dueDate) {
      const due = new Date(c.dueDate + 'T00:00:00');
      if (!isNaN(due.getTime())) {
        due.setHours(0, 0, 0, 0);

        let addedBeforeToday = true;
        if (c.installDate) {
          const install = new Date(c.installDate + 'T00:00:00');
          if (!isNaN(install.getTime())) {
            install.setHours(0, 0, 0, 0);
            addedBeforeToday = (install < today);
          }
        }

        const dueMonthStart = new Date(due.getFullYear(), due.getMonth(), 1);
        dueMonthStart.setHours(0, 0, 0, 0);

        if (addedBeforeToday || today >= dueMonthStart) {
          toCollectCount++;
        }

        if (due < today) {
          pastDue++;
        } else if (due.getTime() === today.getTime()) {
          dueToday++;
        } else if (due <= new Date(today.getTime() + DUE_SOON_DAYS * 86400000)) {
          dueSoon++;
        }
      }
    }
  }

  return { dueToday, dueSoon, pastDue, totalCollected, paidCount, toCollectCount, totalClients };
}

// ---- Search/filter from local DB ----
async function searchLocal(query, filterType) {
  const clients = await dbGetAll('clients');
  debugLog('Local search: ' + clients.length + ' clients in DB, query="' + query + '", filter="' + filterType + '"');

  if (clients.length === 0) {
    debugLog('No clients in local DB — sync may have failed');
    return [];
  }

  const q = (query || '').trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const DUE_SOON_DAYS = 7;

  // Recompute status
  const enriched = clients.map(c => {
    const prevBalance = c.prevBalance || 0;
    const totalDue = (c.amountDue || 0) + prevBalance;
    const balance = totalDue - (c.amountPaid || 0);
    let status = 'UPCOMING';

    if (balance <= 0) {
      status = 'PAID';
    } else if (c.dueDate) {
      const due = new Date(c.dueDate + 'T00:00:00');
      if (!isNaN(due.getTime())) {
        due.setHours(0, 0, 0, 0);
        if (due.getTime() === today.getTime()) status = 'DUE TODAY';
        else if (due > today && due <= new Date(today.getTime() + DUE_SOON_DAYS * 86400000)) status = 'DUE SOON';
        else if (due < today) status = 'PAST DUE';
        else status = 'UPCOMING';
      }
    }
    return { ...c, status, totalDue, balance };
  });

  let results = enriched;

  // Filter by query
  if (q) {
    results = results.filter(c =>
      (c.clientName || '').toLowerCase().includes(q) ||
      (c.username || '').toLowerCase().includes(q)
    );
  }

  // Filter by status
  if (filterType && filterType !== 'ALL') {
    if (filterType === 'PAID TODAY') {
      const todayStr = today.toISOString().split('T')[0];
      results = results.filter(c => c.paymentDate === todayStr);
    } else if (filterType === 'PAID') {
      results = results.filter(c => c.status === 'PAID');
    } else {
      results = results.filter(c => c.status === filterType);
    }
  } else if (!q) {
    results = results.filter(c => c.status !== 'PAID');
  }

  results.sort((a, b) => {
    const da = a.dueDate ? new Date(a.dueDate).getTime() : 9999999999999;
    const db = b.dueDate ? new Date(b.dueDate).getTime() : 9999999999999;
    return da - db;
  });

  debugLog('Local search returned', results.length, 'results');
  return results;
}

// ---- Search (online with offline fallback) ----
async function searchByName(query) {
  // Always try local first (more reliable for PWA)
  const localResults = await searchLocal(query, null);
  if (localResults.length > 0) {
    debugLog('Using local results for search');
    return localResults;
  }

  // If local has nothing and we're online, try server
  if (isOnline()) {
    try {
      const url = API_URL + '?action=search&query=' + encodeURIComponent(query);
      const results = await fetchGAS(url);
      debugLog('Server search returned', results.length, 'results');
      return results;
    } catch (err) {
      debugLog('Server search failed:', err.message);
    }
  }

  return localResults;
}

async function searchByStatus(filterType) {
  // Always try local first
  const localResults = await searchLocal('', filterType);
  if (localResults.length > 0 || !isOnline()) {
    debugLog('Using local results for filter');
    return localResults;
  }

  // If local empty and online, try server
  try {
    const url = API_URL + '?action=search&filter=' + encodeURIComponent(filterType);
    const results = await fetchGAS(url);
    debugLog('Server filter returned', results.length, 'results');
    return results;
  } catch (err) {
    debugLog('Server filter failed:', err.message);
  }

  return localResults;
}

// ---- Add client ----
async function addClient(firstName, lastName, username, installDate) {
  const fullName = firstName.trim() + (lastName.trim() ? ' ' + lastName.trim() : '');
  const usernameFinal = username.trim() || 'N/A';

  // Calculate due date as 1 month from install date
  const install = new Date(installDate + 'T00:00:00');
  install.setMonth(install.getMonth() + 1);
  const dueYear = install.getFullYear();
  const dueMonth = String(install.getMonth() + 1).padStart(2, '0');
  const dueDay = String(install.getDate()).padStart(2, '0');
  const dueDate = dueYear + '-' + dueMonth + '-' + dueDay;

  if (isOnline()) {
    try {
      const result = await fetchGAS(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'addClient', firstName, lastName, username: usernameFinal, dueDate, installDate })
      });

      if (result.success) {
        await dbPut('clients', {
          clientName: fullName,
          username: usernameFinal,
          installDate: installDate,
          dueDate: dueDate,
          amountDue: 650,
          amountPaid: 0,
          balance: 650,
          status: 'UPCOMING',
          installDate: new Date().toISOString().split('T')[0],
          createdDate: new Date().toISOString().split('T')[0],
          paymentDate: '',
          paymentMethod: '',
          notes: ''
        });
      }
      return result;
    } catch (err) {
      debugLog('Online addClient failed:', err.message);
    }
  }

  // Offline
  await dbPut('clients', {
    clientName: fullName,
    username: usernameFinal,
    installDate: installDate,
    dueDate: dueDate,
    amountDue: 650, amountPaid: 0, balance: 650,
    status: 'UPCOMING',
    createdDate: new Date().toISOString().split('T')[0],
    paymentDate: '', paymentMethod: '', notes: '',
    _pendingSync: true
  });

  await dbPut('pendingActions', {
    type: 'addClient',
    data: { firstName, lastName, username: usernameFinal, dueDate, installDate },
    timestamp: new Date().toISOString()
  });

  return { success: true, message: fullName + ' added. Due: ' + dueDate };
}

// ---- Edit client ----
async function editClient(username, firstName, lastName, dueDate, notes) {
  const fullName = firstName.trim() + (lastName.trim() ? ' ' + lastName.trim() : '');

  if (isOnline()) {
    try {
      const result = await fetchGAS(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'editClient', username, firstName, lastName, dueDate, notes })
      });

      if (result.success) {
        const existing = await dbGet('clients', username);
        if (existing) {
          existing.clientName = fullName;
          existing.dueDate = dueDate;
          existing.notes = notes || '';
          await dbPut('clients', existing);
        }
      }
      return result;
    } catch (err) {
      debugLog('Online editClient failed:', err.message);
    }
  }

  const existing = await dbGet('clients', username);
  if (existing) {
    existing.clientName = fullName;
    existing.dueDate = dueDate;
    existing.notes = notes || '';
    existing._pendingSync = true;
    await dbPut('clients', existing);
  }

  await dbPut('pendingActions', {
    type: 'editClient',
    data: { username, firstName, lastName, dueDate, notes },
    timestamp: new Date().toISOString()
  });

  return { success: true, message: 'Updated (offline). Will sync when online.' };
}

// ---- Record payment ----
async function recordPayment(username, amountPaid, method) {
  amountPaid = parseFloat(amountPaid);
  if (isNaN(amountPaid) || amountPaid <= 0) {
    return { success: false, message: 'Invalid amount.' };
  }

  if (isOnline()) {
    try {
      const result = await fetchGAS(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'recordPayment', username, amountPaid, method })
      });

      if (result.success) {
        const existing = await dbGet('clients', username);
        if (existing) {
          existing.amountPaid = (existing.amountPaid || 0) + amountPaid;
          existing.balance = (existing.amountDue || 0) - existing.amountPaid;
          existing.paymentDate = new Date().toISOString().split('T')[0];
          existing.paymentMethod = method || 'CASH';
          await dbPut('clients', existing);
        }
      }
      return result;
    } catch (err) {
      debugLog('Online payment failed:', err.message);
    }
  }

  const existing = await dbGet('clients', username);
  if (existing) {
    existing.amountPaid = (existing.amountPaid || 0) + amountPaid;
    existing.balance = (existing.amountDue || 0) - existing.amountPaid;
    existing.paymentDate = new Date().toISOString().split('T')[0];
    existing.paymentMethod = method || 'CASH';
    existing._pendingSync = true;
    await dbPut('clients', existing);
  }

  await dbPut('pendingActions', {
    type: 'recordPayment',
    data: { username, amountPaid, method },
    timestamp: new Date().toISOString()
  });

  return { success: true, message: 'Payment of ₱' + amountPaid.toFixed(2) + ' recorded (offline). Will sync when online.' };
}

// ---- Get client by username ----
async function getClientByUsername(username) {
  if (isOnline()) {
    try {
      const url = API_URL + '?action=client&username=' + encodeURIComponent(username);
      return await fetchGAS(url);
    } catch (err) {
      debugLog('Online getClient failed:', err.message);
    }
  }

  const client = await dbGet('clients', username);
  if (client) {
    const parts = (client.clientName || '').trim().split(' ');
    return {
      ...client,
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : client.clientName,
      lastName: parts.length > 1 ? parts[parts.length - 1] : ''
    };
  }
  return null;
}

// ---- Delete client ----
async function deleteClientAPI(username) {
  if (isOnline()) {
    try {
      const result = await fetchGAS(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'deleteClient', username })
      });

      if (result.success) {
        await dbDelete('clients', username);
      }
      return result;
    } catch (err) {
      debugLog('Online deleteClient failed:', err.message);
    }
  }

  // Offline: remove locally and queue
  await dbDelete('clients', username);

  await dbPut('pendingActions', {
    type: 'deleteClient',
    data: { username },
    timestamp: new Date().toISOString()
  });

  return { success: true, message: 'Client deleted (offline). Will sync when online.' };
}

// ==================== Sync Engine ====================

async function processPendingActions() {
  if (!isOnline()) return 0;

  const actions = await dbGetAll('pendingActions');
  if (actions.length === 0) return 0;

  actions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let synced = 0;
  for (const action of actions) {
    try {
      // DELETE the action FIRST to prevent duplicate processing
      await dbDelete('pendingActions', action.id);
      debugLog('Processing pending action:', action.type, action.id);

      const result = await fetchGAS(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: action.type, ...action.data })
      });

      if (result.success) {
        synced++;
        debugLog('Synced action:', action.type);
      } else {
        // If failed, re-queue the action
        debugLog('Action failed, re-queuing:', action.type, result.message);
        await dbPut('pendingActions', action);
      }
    } catch (err) {
      debugLog('Sync action failed, re-queuing:', err.message);
      // Re-queue on network error
      await dbPut('pendingActions', action);
      break;
    }
  }

  return synced;
}

async function fullSync() {
  debugLog('Starting full sync...');

  const synced = await processPendingActions();
  debugLog('Pending actions synced:', synced);

  const pullResult = await syncClientsFromServer();
  debugLog('Server pull result:', pullResult);

  if (pullResult.success) {
    await getSummary();
  }

  return { synced, pulled: pullResult.success, pullCount: pullResult.count || 0, pullReason: pullResult.reason || '' };
}

async function getSyncStatus() {
  const pending = await dbGetAll('pendingActions');
  const meta = await dbGet('meta', 'lastSync');
  const clients = await dbGetAll('clients');
  return {
    pendingCount: pending.length,
    lastSync: meta ? meta.value : null,
    isOnline: isOnline(),
    localClientCount: clients.length
  };
}
