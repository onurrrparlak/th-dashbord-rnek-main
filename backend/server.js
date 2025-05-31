require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const ActiveDirectory = require('activedirectory2');
const { v4: uuidv4 } = require('uuid');
const ldap = require('ldapjs');
const fs = require('fs');
const LOG_FILE = path.join(__dirname, '..', 'public', 'logs', 'task_logs.json');


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
let logs = [];

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

// Kullanıcı cache'ini temizle ve AD'den yeniden çek
app.post('/api/refresh-users-cache', (req, res) => {
  cachedUsers = null;
  lastFetchTime = 0;
  res.json({ success: true, message: 'Kullanıcı cache\'i temizlendi. Bir sonraki /users isteğinde güncel veriler çekilecek.' });
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

try {
  if (fs.existsSync(LOG_FILE)) {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    logs = JSON.parse(data);
  }
} catch (err) {
  console.error('Log dosyası okunamadı:', err);
}

// Log ekleme fonksiyonu
function addLog(entry) {
  logs.push(entry);
  // Dosyaya kaydet
  fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2), err => {
    if (err) console.error('Log dosyası yazılamadı:', err);
  });
}

// API logları JSON'dan döndürür
app.get('/api/task-logs', (req, res) => {
  res.json(logs);
});



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
  getUserDN(username, (err, dn) => {
    if (err) {
      addLog({ username, type, status: 'error', timestamp: new Date(), message: err.message, label });
      return;
    }

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

function getUserDN(username, callback) {
  const opts = {
    filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${username}))`,
    attributes: ['distinguishedName']
  };
  ad.find(opts, (err, results) => {
    if (err) return callback(err);
    if (!results.users || results.users.length === 0) return callback(new Error('Kullanıcı bulunamadı'));

    const user = results.users[0];
    const dn = user.distinguishedName || user.dn;

    if (!dn) return callback(new Error('DN bilgisi yok'));

    console.log('Bulunan DN:', dn);
    callback(null, dn);
  });
}


function disableUserDN(dn, callback) {
  const client = ldap.createClient({
    url: process.env.AD_URL
  });

  client.bind(process.env.AD_USERNAME, process.env.AD_PASSWORD, (err) => {
    if (err) return callback(err);

    // Önce userAccountControl al
    const opts = {
      scope: 'base',
      attributes: ['userAccountControl', 'cn']
    };

    client.search(dn, opts, (err, res) => {
      if (err) {
        client.unbind();
        return callback(err);
      }

      let userAccountControl;
      let currentCN;

      res.on('searchEntry', (entry) => {
        userAccountControl = entry.attributes.find(attr => attr.type === 'userAccountControl')?.values[0];
        currentCN = entry.attributes.find(attr => attr.type === 'cn')?.values[0];
      });

      res.on('error', (err) => {
        client.unbind();
        callback(err);
      });

      res.on('end', () => {
        if (userAccountControl === undefined) {
          client.unbind();
          return callback(new Error('userAccountControl bulunamadı'));
        }
        if (!currentCN) {
          client.unbind();
          return callback(new Error('cn bilgisi bulunamadı'));
        }

        let uac = parseInt(userAccountControl);
        uac = uac | 2; // Disable flag'i ekle

        // userAccountControl değişikliğini uygula
        const change = new Change({
          operation: 'replace',
          modification: new Attribute({
            type: 'userAccountControl',
            values: [uac.toString()]
          })
        });

        client.modify(dn, change, (err) => {
          if (err) {
            client.unbind();
            return callback(err);
          }

          // RDN değişikliği için yeni RDN hazırla
          let newCN = currentCN.startsWith('v-') ? currentCN : 'v-' + currentCN;

          // DN içinden RDN çıkar (örn: CN=John Doe,... -> CN=John Doe)
          const rdn = `CN=${currentCN}`;
          const newRdn = `CN=${newCN}`;

          client.modifyDN(dn, newRdn, (err) => {
            client.unbind();
            if (err) return callback(err);
            callback(null);
          });
        });
      });
    });
  });
}



function enableUserDN(dn, callback) {
  const client = ldap.createClient({
    url: process.env.AD_URL
  });

  client.bind(process.env.AD_USERNAME, process.env.AD_PASSWORD, (err) => {
    if (err) {
      return callback(err);
    }

    const opts = {
      scope: 'base',
      attributes: ['userAccountControl']
    };

    client.search(dn, opts, (err, res) => {
      if (err) {
        client.unbind();
        return callback(err);
      }

      let userAccountControl;

      res.on('searchEntry', (entry) => {
        userAccountControl = entry.attributes.find(attr => attr.type === 'userAccountControl')?.values[0];
      });

      res.on('error', (err) => {
        client.unbind();
        callback(err);
      });

      res.on('end', () => {
        if (userAccountControl === undefined) {
          client.unbind();
          return callback(new Error('userAccountControl bulunamadı'));
        }

        let uac = parseInt(userAccountControl);
        uac = uac & (~2);  // Disable flag'i kaldır

        const mod = new Attribute({
          type: 'userAccountControl',
          values: [uac.toString()]
        });

        const change = new Change({
          operation: 'replace',
          modification: mod
        });

        client.modify(dn, change, (err) => {
          client.unbind();
          if (err) {
            return callback(err);
          }
          callback(null);
        });
      });
    });
  });
}





app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
