let users = [];
let currentPage = 1;
const usersPerPage = 10;

async function fetchUsers() {
  try {
    const res = await fetch('/users');
    users = await res.json();
    renderList('');
  } catch (error) {
    console.error('Kullanıcılar alınamadı:', error);
  }
}

function renderList(filter) {
  const filtered = users.filter(user =>
    (user.name || '').toLowerCase().includes(filter) ||
    (user.username || '').toLowerCase().includes(filter) ||
    (user.email || '').toLowerCase().includes(filter)
  );

  const totalPages = Math.ceil(filtered.length / usersPerPage);
  currentPage = Math.min(currentPage, totalPages || 1);

  const start = (currentPage - 1) * usersPerPage;
  const end = start + usersPerPage;
  const paginatedUsers = filtered.slice(start, end);

  const tableBody = document.getElementById('resultsTableBody');
  tableBody.innerHTML = '';

  paginatedUsers.forEach(user => {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${user.name}</td>
      <td>${user.username}</td>
      <td>${user.email || 'e-posta yok'}</td>
      <td>
        <button class="btn btn-sm btn-primary">
          <i class="fas fa-edit"></i> Düzenle
        </button>
      </td>
    `;

    tableBody.appendChild(tr);
  });

  renderPagination(totalPages, filter);
}

function renderPagination(totalPages, filter) {
  const paginationEl = document.getElementById('pagination');
  paginationEl.innerHTML = '';

  for (let i = 1; i <= totalPages; i++) {
    const li = document.createElement('li');
    li.className = 'page-item' + (i === currentPage ? ' active' : '');
    const btn = document.createElement('button');
    btn.className = 'page-link';
    btn.textContent = i;
    btn.addEventListener('click', () => {
      currentPage = i;
      renderList(filter);
    });
    li.appendChild(btn);
    paginationEl.appendChild(li);
  }
}

document.getElementById('searchInput')?.addEventListener('input', (e) => {
  currentPage = 1;
  renderList(e.target.value.toLowerCase());
});

if (window.location.pathname.includes('users.html')) {
  fetchUsers();
}
