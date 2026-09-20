const $ = (id) => document.getElementById(id);

function formatWhen(ms) {
  if (!ms) return 'No scan yet';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'Last scan: just now';
  if (minutes < 60) return `Last scan: ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last scan: ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Last scan: ${new Date(ms).toLocaleDateString()}`;
}

chrome.runtime.sendMessage({ type: 'stats' }, (response) => {
  if (chrome.runtime.lastError || !response?.ok) {
    $('count').textContent = '0';
    return;
  }
  $('count').textContent = response.count.toLocaleString();
  $('meta').textContent = formatWhen(response.lastScanAt);
});

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
});

$('scan').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.instagram.com/' });
  window.close();
});
