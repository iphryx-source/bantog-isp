// ============================================================
// BANTOG ISP — API Layer with Offline Support
// ============================================================
// Replace API_URL with your deployed Apps Script web app URL
// ============================================================

const API_URL = 'https://script.google.com/macros/s/https://script.google.com/macros/s/AKfycbwsZq13QZHLaklJvCcOoShyhc6dPE4NQWYo33gO2qqI_5JoCFraFani4CkmX1yMHKLNOQ/exec/exec';

// ==================== IndexedDB Setup ====================

const DB_NAME = 'BantogISP';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Clients store
      if (!db.objectStoreNames.contains('clients')) {
        const clientStore = db.createObjectStore('clients', { keyPath: 'username' });
        clientStore.createIndex('status', 'status', { unique: false });
        clientStore.createIndex('clientName', 'clientName', { unique: false });
      }

      // Pending actions queue (for offline operations)
      if (!db.objectStoreNames.contains('pendingActions')) {
        const pendingStore = db.createObjectStore('pendingActions', { keyPath: 'id', autoIncrement: true });
        pendingStore.createIndex('timestamp', 'timestamp', { unique: false });
        pendingStore.createIndex('type', 'type', { unique: false });
      }

      // Summary cache
      if (!db.objectStoreNames.contains('summary')) {
        db.createObjectStore('summary', { keyPath: 'id' });
      }

      // App metadata
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

// Fetch with timeout
function fetchWithTimeout(url, options = {}, timeout = 15000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), timeout)
    )
  ]);
}

// ---- Sync all clients to local DB ----
async function syncClientsFromServer() {
  if (!isOnline()) return false;

  try {
    const url = API_URL + '?action=allClients';
    const response = await fetchWithTimeout(url);
    const clients = await response.json();

    if (Array.isArray(clients)) {
      await dbClear('clients');
      for (const client of clients) {
        await dbPut('clients', client);
      }
      await dbPut('meta', { key: 'lastSync', value: new Date().toISOString() });
      return true;
    }
    return false;
  } catch (err) {
    console.error('Sync failed:', err);
    return false;
  }
}

// ---- Get summary (online or offline) ----
async function getSummary() {
  if (isOnline()) {
    try {
      const url = API_URL + '?action=summary';
      const response = await fetchWithTimeout(url);
      const data = await response.json();
      await dbPut('summary', { id: 'current', ...data });
      return data;
    } catch (err) {
      console.error('Online summary failed, using cache:', err);
    }
  }

  // Fallback: compute from local data
  const cached = await dbGet('summary', 'current');
  if (cached) return cached;

  return computeSummaryFromLocal();
}

// Compute summary from local client data
async function computeSummaryFromLocal() {
  const clients = await dbGetAll('clients');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dueToday = 0, dueSoon = 0, pastDue = 0, totalCollected = 0;

  for (const c of clients) {
    if (c.status === 'DUE TODAY') dueToday++;
    else if (c.status === 'DUE SOON') dueSoon++;
    else if (c.status === 'PAST DUE') pastDue++;
    totalCollected += c.amountPaid || 0;
  }

  return { dueToday, dueSoon, pastDue, totalCollected };
}

// ---- Search/filter from local DB ----
async function searchLocal(query, filterType) {
  const clients = await dbGetAll('clients');
  const q = (query || '').trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Recompute status for accuracy
  const enriched = clients.map(c => {
    const balance = (c.amountDue || 0) - (c.amountPaid || 0);
    let status = c.status;

    if (balance <= 0) {
      status = 'PAID';
    } else if (c.dueDate) {
      const due = new Date(c.dueDate);
      due.setHours(0, 0, 0, 0);
      const DUE_SOON_DAYS = 7;
      if (due.getTime() === today.getTime()) status = 'DUE TODAY';
      else if (due > today && due <= new Date(today.getTime() + DUE_SOON_DAYS * 86400000)) status = 'DUE SOON';
      else if (due < today) status = 'PAST DUE';
      else status = 'UPCOMING';
    }
    return { ...c, status, balance };
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
    } else {
      results = results.filter(c => c.status === filterType);
    }
  } else if (!q) {
    // Default: exclude PAID
    results = results.filter(c => c.status !== 'PAID');
  }

  // Sort by due date
  results.sort((a, b) => {
    const da = a.dueDate ? new Date(a.dueDate).getTime() : 9999999999999;
    const db = b.dueDate ? new Date(b.dueDate).getTime() : 9999999999999;
    return da - db;
  });

  return results;
}

// ---- Search (online with offline fallback) ----
async function searchByName(query) {
  if (isOnline()) {
    try {
      const url = API_URL + '?action=search&query=' + encodeURIComponent(query);
      const response = await fetchWithTimeout(url);
      return await response.json();
    } catch (err) {
      console.error('Online search failed, using local:', err);
    }
  }
  return searchLocal(query, null);
}

async function searchByStatus(filterType) {
  if (isOnline()) {
    try {
      const url = API_URL + '?action=search&filter=' + encodeURIComponent(filterType);
      const response = await fetchWithTimeout(url);
      return await response.json();
    } catch (err) {
      console.error('Online filter failed, using local:', err);
    }
  }
  return searchLocal('', filterType);
}

// ---- Add client ----
async function addClient(firstName, lastName, username, dueDate) {
  if (isOnline()) {
    try {
      const response = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'addClient',
          firstName, lastName, username, dueDate
        })
      });
      const result = await response.json();

      // Update local cache
      if (result.success) {
        await dbPut('clients', {
          clientName: firstName.trim() + ' ' + lastName.trim(),
          username: username.trim(),
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
      console.error('Online addClient failed:', err);
    }
  }

  // Offline: queue the action and add locally
  const clientData = {
    clientName: firstName.trim() + ' ' + lastName.trim(),
    username: username.trim(),
    dueDate: dueDate,
    amountDue: 650,
    amountPaid: 0,
    balance: 650,
    status: 'UPCOMING',
    installDate: new Date().toISOString().split('T')[0],
    createdDate: new Date().toISOString().split('T')[0],
    paymentDate: '',
    paymentMethod: '',
    notes: '',
    _pendingSync: true
  };

  await dbPut('clients', clientData);
  await dbPut('pendingActions', {
    type: 'addClient',
    data: { firstName, lastName, username, dueDate },
    timestamp: new Date().toISOString()
  });

  return { success: true, message: firstName.trim() + ' ' + lastName.trim() + ' added (offline). Will sync when online.' };
}

// ---- Edit client ----
async function editClient(username, firstName, lastName, dueDate, notes) {
  if (isOnline()) {
    try {
      const response = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'editClient',
          username, firstName, lastName, dueDate, notes
        })
      });
      const result = await response.json();

      // Update local cache
      if (result.success) {
        const existing = await dbGet('clients', username);
        if (existing) {
          existing.clientName = firstName.trim() + ' ' + lastName.trim();
          existing.dueDate = dueDate;
          existing.notes = notes || '';
          await dbPut('clients', existing);
        }
      }

      return result;
    } catch (err) {
      console.error('Online editClient failed:', err);
    }
  }

  // Offline: queue and update locally
  const existing = await dbGet('clients', username);
  if (existing) {
    existing.clientName = firstName.trim() + ' ' + lastName.trim();
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
      const response = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'recordPayment',
          username, amountPaid, method
        })
      });
      const result = await response.json();

      // Update local cache
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
      console.error('Online payment failed:', err);
    }
  }

  // Offline: queue and update locally
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
      const response = await fetchWithTimeout(url);
      return await response.json();
    } catch (err) {
      console.error('Online getClient failed:', err);
    }
  }

  // Fallback to local
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

// ==================== Sync Engine ====================

async function processPendingActions() {
  if (!isOnline()) return 0;

  const actions = await dbGetAll('pendingActions');
  if (actions.length === 0) return 0;

  let synced = 0;

  // Sort by timestamp
  actions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const action of actions) {
    try {
      const response = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: action.type, ...action.data })
      });
      const result = await response.json();

      if (result.success) {
        await dbDelete('pendingActions', action.id);
        synced++;
      }
    } catch (err) {
      console.error('Sync action failed:', err);
      break; // Stop on first failure
    }
  }

  return synced;
}

async function fullSync() {
  // 1. Process pending offline actions
  const synced = await processPendingActions();

  // 2. Pull fresh data from server
  const pulled = await syncClientsFromServer();

  // 3. Update summary
  if (pulled) {
    await getSummary();
  }

  return { synced, pulled };
}

// ==================== Get sync status ====================
async function getSyncStatus() {
  const pending = await dbGetAll('pendingActions');
  const meta = await dbGet('meta', 'lastSync');
  return {
    pendingCount: pending.length,
    lastSync: meta ? meta.value : null,
    isOnline: isOnline()
  };
}
