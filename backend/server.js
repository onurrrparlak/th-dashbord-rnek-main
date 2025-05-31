require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const ActiveDirectory = require('activedirectory2');
const { v4: uuidv4 } = require('uuid');
const { Change, Attribute } = require('ldapjs');


const app = express();
const PORT = 3000;


const config = {
  url: process.env.AD_URL,
  baseDN: process.env.AD_BASE_DN,
  username: process.env.AD_USERNAME,
  password: process.env.AD_PASSWORD
};


const ad = new ActiveDirectory(config);

let cachedUsers = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 dakika


app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'public')));



app.get('/users', (req, res) => {
  const now = Date.now();

  // Eğer cache taze ise, bellektekini gönder
  if (cachedUsers && (now - lastFetchTime < CACHE_DURATION_MS)) {
    console.log("⚡ Bellekten kullanıcı verisi gönderildi");
    return res.json(cachedUsers);
  }

  const opts = {
    filter: '(&(objectCategory=person)(objectClass=user))',
    scope: 'sub',
    paged: true,
    attributes: ['displayName', 'cn', 'sAMAccountName', 'mail', 'userAccountControl']
  };

  ad.find(opts, (err, results) => {
    if (err) {
      console.error('❌ AD kullanıcı çekme hatası:', err);
      return res.status(500).json({ error: 'AD hatası' });
    }

    const users = results.users || [];
    console.log(`📥 AD'den gelen toplam kullanıcı sayısı: ${users.length}`);

    users.sort((a, b) => {
      const nameA = (a.displayName || a.cn || '').toLowerCase();
      const nameB = (b.displayName || b.cn || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const cleaned = users.map(user => ({
      name: user.displayName || user.cn || 'İsimsiz',
      username: user.sAMAccountName || '',
      fullName: user.cn || '',
      email: user.mail || '',
      disabled: (user.userAccountControl & 2) === 2
    }));

    // Cache'i güncelle
    cachedUsers = cleaned;
    lastFetchTime = now;

    return res.json(cleaned);
  });
});



app.get('/users/:username', (req, res) => {
  const username = req.params.username;

  const opts = {
    filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${username}))`,
    attributes: ['displayName', 'cn', 'sAMAccountName', 'mail', 'title', 'department', 'telephoneNumber']
  };

  ad.find(opts, (err, results) => {
    if (err) {
      console.error('❌ AD kullanıcı detayı hatası:', err);
      return res.status(500).json({ error: 'AD hatası' });
    }

    const user = results.users && results.users[0];
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    const cleaned = {
      dn: user.dn,
      name: user.displayName || user.cn || 'İsimsiz',
      username: user.sAMAccountName || '',
      email: user.mail || '',
      title: user.title || '',
      department: user.department || '',
      phone: user.telephoneNumber || ''
    };

    return res.json(cleaned);
  });
});


let scheduledTasks = [];

const logs = []; // ⬅️ EKLE
function addLog(entry) {
  logs.push(entry);
}

const ldap = require('ldapjs');

function enableUserDN(dn, callback) {
  const client = ldap.createClient({ url: process.env.AD_URL });

  client.bind(process.env.AD_USERNAME, process.env.AD_PASSWORD, (err) => {
    if (err) {
      console.error('❌ LDAP bind hatası:', err);
      return callback(err);
    }

    const attribute = new Attribute({
      type: 'userAccountControl',
      values: ['512']
    });

    const change = new Change({
      operation: 'replace',
      modification: attribute
    });

    client.modify(dn, change, (err) => {
      if (err) {
        console.error('❌ Kullanıcı aktif etme hatası:', err);
        return callback(err);
      }

      console.log('✅ Kullanıcı aktif hale getirildi:', dn);
      callback(null);
    });
  });
}



app.get('/api/active-tasks', (req, res) => {
  const now = Date.now();

  const upcoming = scheduledTasks.filter(task => {
    const runAt = new Date(task.runAt).getTime();
    return runAt > now;
  });

  res.json(upcoming);
});




app.post('/api/schedule-task', (req, res) => {
  const { type, username, runAt, description, label } = req.body;

  if (!['activate_user', 'deactivate_user'].includes(type)) {
    return res.status(400).json({ error: 'Geçersiz görev tipi.' });
  }

  const date = new Date(runAt);
  const id = uuidv4();

  const job = schedule.scheduleJob(date, () => {
    const dn = `CN=${username},${process.env.AD_USER_DN}`;

    if (type === 'activate_user') {
      enableUserDN(dn, (err) => {
        if (err) {
          addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
        } else {
          addLog({ username, type, status: 'success', timestamp: new Date(), message: 'Aktif edildi', label });
        }
      });
    } else if (type === 'deactivate_user') {
      disableUserDN(dn, (err) => {
        if (err) {
          addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
        } else {
          addLog({ username, type, status: 'success', timestamp: new Date(), message: 'Deaktif edildi', label });
        }
      });
    }
  });

  scheduledTasks.push({
    id,
    username,
    type,
    runAt,
    description: description || `${type} görevi`,
    label: label || username
  });

  res.json({ success: true });
});

app.get('/api/task-logs', (req, res) => {
  res.json(logs);
});








app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
