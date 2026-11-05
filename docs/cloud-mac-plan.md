# Cloud Mac: decisions and next steps

Moving mac-bench from Kevin's MacBook to a hosted Mac, which will also run
Stem Shovel's DAW tests (Ableton Live, Logic Pro) beside Dorico. Research:
[docs/research/2026-11-05-cloud-mac.md](research/2026-11-05-cloud-mac.md)
(prices and claims as researched on 2026-11-05; not all re-checked).

## Decided (Kevin, 2026-11-05)

- **Hosted bare metal at MacStadium**, month to month, over buying a Mac
  mini. Logic Pro rules out macOS VMs (the App Store won't sign in there).
  Suggested size: **M4.L** (M4 Pro, 48 GB, 1 TB, about $349 a month):
  Logic's sound library and the packs need the storage, and clean-install
  VMs for a future native app need the memory beside the DAWs.
- **No personal iCloud on the cloud Mac.** Lightning Jar enrols in
  **Apple Business Manager**, the Mac is enrolled in a device-management
  service (MDM), and Logic is bought through Apps and Books and assigned
  to the device, so no Apple ID is signed in. The MDM also stops macOS
  15's monthly screen-recording prompt.
- **Rebuildable, not backed up.** The Mac can be cancelled and rented
  again later: everything comes from a setup script, GitHub and
  1Password, and nothing important lives only on the Mac.
- **A future Stem Shovel native app** (e.g. a project-sync helper) is
  built, signed and notarised in GitHub Actions; signing keys never go on
  the test Mac. Clean-install and upgrade tests run in macOS VMs on it
  (two per Mac under Apple's licence); integration tests with the DAWs
  run on the Mac itself.

## Status

- [x] Apple Business Manager application submitted (Kevin, 2026-11-05).
  **Skip domain verification** for now: verifying `lightningjar.com`
  asks every personal Apple ID on that domain to change its address.
- [x] Apple approved the application (2026-11-05).
- [x] Ordered from MacStadium (2026-11-05): **M2.XL** (M2 Pro, 32 GB,
  2 TB, $349 a month) in **Dublin**, the only region with stock; no
  M4.L was offered. It came with **macOS 27.2** (no choice at order).
  Dorico 6.2.31 and Ableton Live 12 are listed as supported on macOS 27
  on Apple silicon (Steinberg's and Ableton's compatibility pages); some
  forum reports of crashes on 27.0/27.0.1. User `administrator`.
  Still to ask MacStadium: whether updates can be held; a pause that
  keeps the disk; whether the Mac has an audio device; a move to a US
  M4.L when one is free (model changes carry no penalty, they say).
- [x] Checked: `forceBypassScreenCaptureAlert` (Restrictions,
  `com.apple.applicationaccess`) is macOS 15.1+, not supervised-only,
  MDM-only (`allowmanualinstall: false`) and refused under User
  Enrollment, per Apple's device-management schema. So a whole-Mac
  enrollment approved by hand works: no wipe, nothing needed from
  MacStadium.
- [ ] First access (Kevin, over SSH): change the password (1Password),
  Homebrew, Tailscale as a system daemon (`brew services`, hostname
  `mac-bench`), mosh (allow `mosh-server` in the firewall if it's on),
  the VM's restricted key. Then close SSH from the internet.
- [ ] Choose an MDM (free to a few dollars a month for one Mac).
- [ ] Write the setup script in this repo: Homebrew bundle (Tailscale as
  a system daemon, BlackHole, Bun, git), clone, `.env.local` from
  1Password, the launchd agent; plus the settings that can't be scripted
  (auto-login with FileVault off, Dorico's Remote Control, the MDM
  profile).
- [ ] Write the "before you cancel" checklist: deactivate Dorico in
  Steinberg's Activation Manager, deauthorize Ableton, remove the Mac
  from the MDM, then cancel.
- [ ] Set up the Mac; buy Logic through Apps and Books; install Dorico,
  Ableton and Logic; move `MAC_BENCH_URL` to it; run the Dorico checks.
- [ ] Rebuild it once from the script early, before anything depends on it.
- [ ] Free the MacBook: Remote Login off; the helper can stay or be
  removed (`launchctl bootout gui/$UID/dev.lj.mac-bench`); deactivate
  Dorico there only if the three Steinberg activations run short.

## Licences on the cloud Mac

- Dorico: one of three Steinberg activations.
- Ableton Live: the second of two authorizations (the MacBook has the
  other).
- Logic Pro: Lightning Jar's own copy, assigned to the device.
