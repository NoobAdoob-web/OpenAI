const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve('/home/user/OpenAI/chrome-scraper-extension');

(async () => {
  const browser = await chromium.launchPersistentContext('', {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
    ],
  });

  async function debugPage(url, label) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`DEBUGGING: ${label}`);
    console.log(`URL: ${url}`);
    console.log('='.repeat(60));

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      // ── Helpers ──
      function visible(el) {
        if (!el) return false;
        try {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function notHidden(el) {
        if (!el) return false;
        try {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        } catch (_) { return false; }
      }

      // Count elements
      const allImgs = document.querySelectorAll('img');
      const allVideos = document.querySelectorAll('video');
      const visibleImgs = [...allImgs].filter(visible);
      const notHiddenImgs = [...allImgs].filter(notHidden);
      const notHiddenVideos = [...allVideos].filter(notHidden);

      // Check role containers
      const roleMain = document.querySelector('[role="main"]');
      const roleFeed = document.querySelector('[role="feed"]');
      const roleList = document.querySelector('[role="list"]');
      const roleTabpanel = document.querySelector('[role="tabpanel"]');

      // Check tables
      const tables = document.querySelectorAll('table');

      // Sample img elements
      const imgSamples = [...allImgs].slice(0, 5).map(img => ({
        src: (img.src || '').slice(0, 60),
        dataSrc: (img.getAttribute('data-src') || '').slice(0, 60),
        srcset: (img.getAttribute('srcset') || '').slice(0, 60),
        width: img.getBoundingClientRect().width,
        height: img.getBoundingClientRect().height,
        visibleCheck: visible(img),
        notHiddenCheck: notHidden(img),
        parentTag: img.parentElement?.tagName,
        display: window.getComputedStyle(img).display,
      }));

      // Walk from notHidden images to find grid containers
      const containers = [];
      document.querySelectorAll('img, video').forEach(media => {
        if (!notHidden(media)) return;
        let el = media.parentElement;
        for (let i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
          if (!notHidden(el)) continue;
          const mediaChildren = [...el.children].filter(c =>
            c.tagName === 'IMG' || c.tagName === 'VIDEO' || c.querySelector('img, video')
          );
          if (mediaChildren.length >= 3) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
              const exists = containers.some(c => c.el === el);
              if (!exists) {
                containers.push({
                  tag: el.tagName,
                  classes: [...el.classList].slice(0, 4).join(' '),
                  childCount: mediaChildren.length,
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                  role: el.getAttribute('role'),
                });
              }
            }
          }
        }
      });

      return {
        title: document.title.slice(0, 60),
        url: location.href,
        allImgs: allImgs.length,
        allVideos: allVideos.length,
        visibleImgs: visibleImgs.length,
        notHiddenImgs: notHiddenImgs.length,
        notHiddenVideos: notHiddenVideos.length,
        tables: tables.length,
        roleMain: roleMain ? `${roleMain.tagName} (${[...roleMain.classList].slice(0,2).join(' ')})` : 'MISSING',
        roleFeed: roleFeed ? 'found' : 'missing',
        roleList: roleList ? 'found' : 'missing',
        roleTabpanel: roleTabpanel ? 'found' : 'missing',
        imgSamples,
        containers: containers.slice(0, 5),
      };
    });

    console.log('\n--- Page Info ---');
    console.log('Title:', result.title);
    console.log('Total imgs:', result.allImgs, '| visible:', result.visibleImgs, '| notHidden:', result.notHiddenImgs);
    console.log('Total videos:', result.allVideos, '| notHidden:', result.notHiddenVideos);
    console.log('Tables:', result.tables);
    console.log('[role=main]:', result.roleMain);
    console.log('[role=feed]:', result.roleFeed, '| [role=list]:', result.roleList, '| [role=tabpanel]:', result.roleTabpanel);
    console.log('\n--- Image samples ---');
    result.imgSamples.forEach((img, i) => {
      console.log(`img[${i}]: ${img.width}x${img.height} visible=${img.visibleCheck} notHidden=${img.notHiddenCheck} display=${img.display} src=${img.src || img.dataSrc || img.srcset || '(empty)'}`);
    });
    console.log('\n--- Grid containers found (walk-from-media) ---');
    if (result.containers.length === 0) {
      console.log('NONE FOUND');
    } else {
      result.containers.forEach((c, i) => {
        console.log(`container[${i}]: <${c.tag}> classes="${c.classes}" role="${c.role}" children=${c.childCount} size=${c.width}x${c.height}`);
      });
    }

    await page.close();
  }

  try {
    await debugPage('https://www.instagram.com/fayedsouza/reels/?hl=en', 'Instagram Reels');
  } catch(e) { console.log('Instagram error:', e.message); }

  try {
    await debugPage('https://www.youtube.com/@AajTakRadio/videos', 'YouTube Videos');
  } catch(e) { console.log('YouTube error:', e.message); }

  await browser.close();
})();
