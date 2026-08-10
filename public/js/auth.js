/**
 * OG Bike Rentals - Authentication & UI Helper Module
 */

// Global Toast Notification Helper
function showNotification(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '✓ ' : type === 'error' ? '✕ ' : 'ℹ ';
  toast.innerText = `${icon} ${message}`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3500);
}

// Session Check Helper
async function checkAuthSession() {
  try {
    const response = await fetch('/api/auth/session');
    const data = await response.json();
    if (response.ok && data.success && data.user) {
      return { authenticated: true, user: data.user };
    }
    return { authenticated: false, user: null };
  } catch (err) {
    console.error('Session check failed:', err);
    return { authenticated: false, user: null };
  }
}

// Logout Handler
async function handleLogout() {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const data = await response.json();
    showNotification(data.message || 'Signed out successfully.', 'info');
    setTimeout(() => {
      window.location.href = '/login';
    }, 800);
  } catch (err) {
    console.error('Logout error:', err);
    window.location.href = '/login';
  }
}

// Automatically sync navbar auth links on index & dashboard pages
async function syncNavbar() {
  const navLinks = document.querySelector('nav .nav-links');
  if (navLinks) {
    const session = await checkAuthSession();

    // Check if Admin link already exists
    let adminLi = document.getElementById('nav-admin-portal-item');
    if (session.authenticated && session.user.role === 'admin') {
      if (!adminLi) {
        adminLi = document.createElement('li');
        adminLi.id = 'nav-admin-portal-item';
        adminLi.innerHTML = `<a href="/admin" class="nav-btn-secondary" style="border-color: var(--accent-cyan); color: var(--accent-cyan);">Admin Portal</a>`;
        navLinks.insertBefore(adminLi, navLinks.firstChild);
      }
    } else if (adminLi) {
      adminLi.remove();
    }

    if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
      let authLi = document.getElementById('nav-auth-item');
      if (!authLi) {
        authLi = document.createElement('li');
        authLi.id = 'nav-auth-item';
        navLinks.appendChild(authLi);
      }

      if (session.authenticated) {
        authLi.innerHTML = `<a href="/dashboard" class="nav-btn">Dashboard</a>`;
      } else {
        authLi.innerHTML = `<a href="/login" class="nav-btn">Sign In</a>`;
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', syncNavbar);
window.addEventListener('pageshow', syncNavbar);
