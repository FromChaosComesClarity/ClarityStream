'use strict';
// Adding a kernel parameter is the one genuinely invasive thing Clarity
// Stream does, so it is done the way each bootloader intends, as a drop-in
// file that can be deleted to undo it. Nothing here edits a file the
// distribution owns.

const fs = require('node:fs');
const { tryExec } = require('./run');

const DROPIN_NAME = 'clarity-stream';

function detect() {
  // Limine with limine-entry-tool, which is what Omarchy ships. Kernel
  // arguments come from drop-ins that append to KERNEL_CMDLINE[default].
  if (fs.existsSync('/etc/limine-entry-tool.d') || fs.existsSync('/etc/limine-entry-tool.conf')) {
    return {
      kind: 'limine-entry-tool',
      dropinPath: `/etc/limine-entry-tool.d/${DROPIN_NAME}.conf`,
      regenerate: ['limine-update'],
      usesUki: /ENABLE_UKI=yes/.test(
        ['/etc/limine-entry-tool.conf', '/etc/limine-entry-tool.d/omarchy-uki.conf']
          .map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })
          .join('\n')
      )
    };
  }
  if (fs.existsSync('/etc/kernel/cmdline') && fs.existsSync('/boot/loader/loader.conf')) {
    return { kind: 'systemd-boot', cmdlinePath: '/etc/kernel/cmdline', regenerate: ['bootctl', 'update'] };
  }
  if (fs.existsSync('/etc/default/grub')) {
    return { kind: 'grub', dropinPath: '/etc/default/grub.d/clarity-stream.cfg', regenerate: ['grub-mkconfig', '-o', '/boot/grub/grub.cfg'] };
  }
  return { kind: null };
}

function dropinContents(params) {
  const joined = params.join(' ');
  return [
    '# Clarity Stream. Added so the phantom stream display exists at boot.',
    '# Delete this file and regenerate the boot entry to undo it; nothing',
    '# else on the system was modified.',
    `KERNEL_CMDLINE[default]+=" ${joined}"`,
    ''
  ].join('\n');
}

// Returns the exact commands a privileged helper must run. The engine never
// shells out to sudo itself: the UI shows this plan, the user approves it,
// and one pkexec call runs it.
function planAddParams(params) {
  const bl = detect();
  if (!bl.kind) {
    return { ok: false, reason: 'No supported bootloader configuration found.', bootloader: bl };
  }
  const already = (fs.readFileSync('/proc/cmdline', 'utf8') || '');
  const missing = params.filter((p) => !already.includes(p));
  if (missing.length === 0) {
    return { ok: true, bootloader: bl, alreadyActive: true, steps: [] };
  }

  if (bl.kind === 'limine-entry-tool' || bl.kind === 'grub') {
    const body = bl.kind === 'grub'
      ? `GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT ${params.join(' ')}"\n`
      : dropinContents(params);
    return {
      ok: true,
      bootloader: bl,
      alreadyActive: false,
      rebootRequired: true,
      steps: [
        { kind: 'write-file', path: bl.dropinPath, contents: body, mode: 0o644 },
        { kind: 'run', argv: bl.regenerate }
      ]
    };
  }

  if (bl.kind === 'systemd-boot') {
    const current = fs.readFileSync(bl.cmdlinePath, 'utf8').trim();
    return {
      ok: true,
      bootloader: bl,
      alreadyActive: false,
      rebootRequired: true,
      steps: [
        { kind: 'write-file', path: bl.cmdlinePath, contents: `${current} ${params.join(' ')}\n`, mode: 0o644 },
        { kind: 'run', argv: bl.regenerate }
      ]
    };
  }
  return { ok: false, reason: `Unhandled bootloader ${bl.kind}`, bootloader: bl };
}

function planRemoveParams() {
  const bl = detect();
  if (!bl.kind || !bl.dropinPath) return { ok: false, reason: 'Nothing to remove.', bootloader: bl };
  return {
    ok: true,
    bootloader: bl,
    rebootRequired: true,
    steps: [
      { kind: 'remove-file', path: bl.dropinPath },
      { kind: 'run', argv: bl.regenerate }
    ]
  };
}

module.exports = { detect, planAddParams, planRemoveParams, dropinContents, DROPIN_NAME };
