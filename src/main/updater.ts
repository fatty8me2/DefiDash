import { app, dialog, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

// Download in the background automatically, but never install without asking.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

let updateInProgress = false;

function getWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0];
}

function wireEvents(): void {
  autoUpdater.on('update-downloaded', async (info) => {
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win!, {
      type: 'info',
      buttons: ['Restart & Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `Version ${info.version} is ready to install.`,
      detail: 'The app will restart to apply the update. You can also install it later when you close the app.'
    });
    if (response === 0) {
      autoUpdater.autoInstallOnAppQuit = true;
      setImmediate(() => autoUpdater.quitAndInstall());
    } else {
      // Install silently the next time the user quits the app.
      autoUpdater.autoInstallOnAppQuit = true;
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message ?? err);
  });
}

/** Check for updates on launch. Silent if already up to date. */
export function initAutoUpdates(): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped (not packaged / dev mode)');
    return;
  }
  // macOS builds are unsigned, and Squirrel.Mac auto-update requires signing —
  // so on Mac new versions are installed manually from the releases page.
  if (process.platform === 'darwin') {
    console.log('[updater] auto-update disabled on macOS (unsigned build)');
    return;
  }
  wireEvents();
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err?.message ?? err);
  });
}

/** Manual check triggered from the UI. Reports the result to the user. */
export async function checkForUpdatesManual(): Promise<void> {
  const win = getWindow();
  if (!app.isPackaged) {
    await dialog.showMessageBox(win!, {
      type: 'info',
      message: 'Updates are only available in the installed app.',
      buttons: ['OK']
    });
    return;
  }
  if (process.platform === 'darwin') {
    await dialog.showMessageBox(win!, {
      type: 'info',
      title: 'Updates on macOS',
      message: 'On macOS, download the latest version from the releases page.',
      detail: 'https://github.com/fatty8me2/DefiDash/releases/latest',
      buttons: ['OK']
    });
    return;
  }
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const hasUpdate = info && info.version !== app.getVersion();
    if (!hasUpdate) {
      await dialog.showMessageBox(win!, {
        type: 'info',
        title: 'No Updates',
        message: `You're on the latest version (${app.getVersion()}).`,
        buttons: ['OK']
      });
    }
    // If there is an update, autoDownload kicks in and 'update-downloaded' prompts to install.
  } catch (err: any) {
    await dialog.showMessageBox(win!, {
      type: 'error',
      title: 'Update Check Failed',
      message: 'Could not check for updates.',
      detail: err?.message ?? String(err),
      buttons: ['OK']
    });
  } finally {
    updateInProgress = false;
  }
}
