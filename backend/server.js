require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const ActiveDirectory = require('activedirectory2');
const { v4: uuidv4 } = require('uuid');
const ldap = require('ldapjs');
const fs = require('fs');

const { Change, Attribute } = require('ldapjs');
const app = express();
const PORT = 3000;
const LOG_FILE = path.join(__dirname, '..', 'public', 'logs', 'task_logs.json');
const caCert = fs.readFileSync(path.join(__dirname, 'certs', 'test-THTEST-CA.cer'));

// AD Config
const config = {
  url: process.env.AD_URL,
  baseDN: process.env.AD_BASE_DN,
  username: process.env.AD_USERNAME,
  password: process.env.AD_PASSWORD,
  tlsOptions: {
    ca: [caCert],
    rejectUnauthorized: false
  }
};

console.log("📄 CA sertifikası yüklendi, boyutu:", caCert.length, "byte");
console.log("🔒 İlk satır:", caCert.toString().split('\n')[0]);

const ad = new ActiveDirectory(config);
let cachedUsers = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;
let logs = [];
let scheduledTasks = [];

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Global error catchers
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED PROMISE REJECTION]', reason);
});

// LDAP Client creation
function createLdapClient() {
  const client = ldap.createClient({
    url: process.env.AD_URL,
    tlsOptions: {
      ca: [caCert],
      rejectUnauthorized: false
    }
  });

  client.on('error', (err) => {
    console.error(`[LDAP ERROR] ${new Date().toISOString()} - ${err.message}`);
  });

  return client;
}

// Cache refresh for logs
if (fs.existsSync(LOG_FILE)) {
  try {
    logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch (err) {
    console.error('Log dosyası okunamadı:', err);
  }
}

// Add log function
function addLog(entry) {
  logs.push(entry);
  fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2), err => {
    if (err) console.error('Log dosyası yazılamadı:', err);
  });
}

// User Data Fetch - Cache mechanism
app.get('/users', (req, res) => {
  const now = Date.now();
  if (cachedUsers && (now - lastFetchTime < CACHE_DURATION_MS)) {
    console.log("⚡ Bellekten kullanıcı verisi gönderildi");
    return res.json(cachedUsers);
  }

  const opts = {
    filter: '(&(objectCategory=person)(objectClass=user))',
    scope: 'sub',
    attributes: ['displayName', 'cn', 'sAMAccountName', 'mail', 'userAccountControl']
  };

 ad.find(opts, (err, results) => {
  if (err || !results || !results.users || !Array.isArray(results.users)) {
    console.error('❌ AD kullanıcı çekme hatası:', err || 'boş sonuç');
    return res.status(500).json({ error: 'AD hatası' });
  }

  const users = results.users.sort((a, b) => (a.displayName || a.cn).localeCompare(b.displayName || b.cn));
  cachedUsers = users.map(user => ({
    name: user.displayName || user.cn || 'İsimsiz',
    username: user.sAMAccountName || '',
    fullName: user.cn || '',
    email: user.mail || '',
    disabled: (user.userAccountControl & 2) === 2
  }));

  if (!results || !results.users || results.users.length === 0) {
  return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
}


  lastFetchTime = now;
  res.json(cachedUsers);
});

});

// Clear the user cache
app.post('/api/refresh-users-cache', (req, res) => {
  cachedUsers = null;
  lastFetchTime = 0;
  res.json({ success: true, message: 'Kullanıcı cache\'i temizlendi.' });
});

// User Detail Fetch
app.get('/users/:username', (req, res) => {
  const username = req.params.username;
  const opts = {
    filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${username}))`,
    attributes: ['displayName', 'cn', 'sAMAccountName', 'mail', 'title', 'department', 'telephoneNumber']
  };

  ad.find(opts, (err, results) => {
    if (err || !results || !results.users || !results.users.length) {
      console.error('❌ AD kullanıcı detayı hatası:', err);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    const user = results.users[0];
    res.json({
      dn: user.dn,
      name: user.displayName || user.cn || 'İsimsiz',
      username: user.sAMAccountName || '',
      email: user.mail || '',
      title: user.title || '',
      department: user.department || '',
      phone: user.telephoneNumber || ''
    });
  });
});

// Task Logs & Active Tasks
app.get('/api/task-logs', (req, res) => res.json(logs));
app.get('/api/active-tasks', (req, res) => {
  const now = Date.now();
  res.json(scheduledTasks.filter(task => new Date(task.runAt).getTime() > now));
});

// Schedule Task for Reset Password, Activate/Deactivate User
app.post('/api/schedule-task', (req, res) => {
  const { type, username, runAt, description, label } = req.body;

  if (!['activate_user', 'deactivate_user', 'reset_password'].includes(type)) {
    return res.status(400).json({ error: 'Geçersiz görev tipi.' });
  }

  const date = new Date(runAt);
  const id = uuidv4();

  schedule.scheduleJob(date, () => {
    if (type === 'reset_password') {
      console.log(`[${new Date().toISOString()}] Görev tetiklendi: reset_password - Kullanıcı: ${username}`);

      getUserFullName(username, (err, user) => {
        if (err) {
          console.error(`[getUserFullName HATA]: ${err.message}`);
          return addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
        }

        const newPassword = generatePassword(user.givenName, user.surname);
        resetUserPassword(user.dn, newPassword, (err) => {
          if (err) {
            return addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
          }
          addLog({ username, type, status: 'success', timestamp: new Date(), message: `Şifre sıfırlandı: ${newPassword}`, label });
        });
      });

    } else {
      getUserDN(username, (err, dn) => {
        if (err) return addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });

        const action = type === 'activate_user' ? enableUserDN : disableUserDN;
        const successMsg = type === 'activate_user' ? 'Aktif edildi' : 'Deaktif edildi';

        action(dn, (err) => {
          if (err) return addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
          addLog({ username, type, status: 'success', timestamp: new Date(), message: successMsg, label });
        });
      });
    }
  });

  scheduledTasks.push({ id, username, type, runAt, description: description || `${type} görevi`, label: label || username });
  res.json({ success: true });
});

// Utility Functions
function getUserDN(username, callback) {
  const opts = {
    filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${username}))`,
    attributes: ['distinguishedName']
  };
  ad.find(opts, (err, results) => {
    if (err || !results.users?.length) return callback(new Error('Kullanıcı bulunamadı'));
    callback(null, results.users[0].distinguishedName || results.users[0].dn);
  });
}

function getUserFullName(username, callback) {
  const opts = {
    filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${username}))`,
    attributes: ['givenName', 'sn', 'distinguishedName']
  };
  ad.find(opts, (err, results) => {
    if (err || !results.users?.length) return callback(new Error('Kullanıcı bulunamadı'));
    const user = results.users[0];
    if (!user.givenName || !user.sn || !user.distinguishedName) return callback(new Error('Eksik kullanıcı bilgisi'));
    callback(null, { givenName: user.givenName, surname: user.sn, dn: user.distinguishedName });
  });
}

function resetUserPassword(dn, newPassword, callback) {
  const client = createLdapClient();
  client.bind(process.env.AD_USERNAME, process.env.AD_PASSWORD, (err) => {
    if (err) return callback(err);

    const pwdUnicode = `"${newPassword}"`;
    const buf = Buffer.from(pwdUnicode, 'utf16le');
    const change = new Change({
      operation: 'replace',
      modification: new Attribute({ type: 'unicodePwd', values: [buf] })
    });

    client.modify(dn, change, (err) => {
      client.unbind();
      callback(err || null);
    });
  });
}

function generatePassword(givenName, surname) {
  return `${givenName.charAt(0).toUpperCase()}${surname.charAt(0).toLowerCase()}1q2w3e!!`;
}

app.listen(PORT, () => {
  console.log(`🚀 Sunucu çalışıyor: http://localhost:${PORT}`);
});
