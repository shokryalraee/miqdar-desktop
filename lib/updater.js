'use strict';
// Silent auto-update state machine around electron-updater (injectable → unit-testable). No dialogs, no notifications, errors swallowed.
// Windows (NSIS, unsigned OK): check at start + every 4h, download in the background, install when the app quits (or on «restart now» from the web bar).
// macOS: Squirrel.Mac needs a SIGNED + notarized app — unsigned builds cannot self-update (manual download), see OWNER-STEPS.md.
function createUpdater({ autoUpdater, intervalMs, onChange, setIntervalFn }) {
  const st = { status: 'idle', version: null, error: '', checkedAt: 0 };
  const set = o => { Object.assign(st, o); try { onChange && onChange({ ...st }); } catch (_) {} };
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.allowDowngrade = false; autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => set({ status: st.status === 'ready' ? 'ready' : 'checking', checkedAt: Date.now() }));
  autoUpdater.on('update-available', i => set({ status: 'downloading', version: i && i.version || null, error: '' }));
  autoUpdater.on('update-not-available', () => { if (st.status !== 'ready') set({ status: 'idle' }); });
  autoUpdater.on('update-downloaded', i => set({ status: 'ready', version: i && i.version || st.version }));
  autoUpdater.on('error', e => { if (st.status !== 'ready') set({ status: 'idle', error: String(e && e.message || e).slice(0, 160) }); });
  const check = () => { if (st.status === 'ready' || st.status === 'downloading') return Promise.resolve(); try { return Promise.resolve(autoUpdater.checkForUpdates()).catch(e => set({ status: 'idle', error: String(e && e.message || e).slice(0, 160) })); } catch (e) { set({ status: 'idle', error: String(e.message || e).slice(0, 160) }); return Promise.resolve(); } };
  let timer = null;
  return {
    state: () => ({ ...st }), check,
    start() { check(); timer = (setIntervalFn || setInterval)(check, intervalMs || 4 * 3600 * 1000); if (timer && timer.unref) timer.unref(); return this; },
    stop() { if (timer) clearInterval(timer); },
    restart() { if (st.status !== 'ready') return false; autoUpdater.quitAndInstall(true, true); return true; },   // silent installer, relaunch
  };
}
module.exports = { createUpdater };
