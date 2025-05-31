document.addEventListener("DOMContentLoaded", function () {
  const sidebarContainer = document.getElementById("sidebar");
  if (sidebarContainer) {
    fetch("../sidebar.html")
      .then(res => res.text())
      .then(html => {
        sidebarContainer.innerHTML = html;
      });
  }
});
