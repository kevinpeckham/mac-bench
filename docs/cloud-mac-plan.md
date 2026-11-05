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
  keeps the disk; a move to a US
  M4.L when one is free (model changes carry no penalty, they say).
- [x] Checked: `forceBypassScreenCaptureAlert` (Restrictions,
  `com.apple.applicationaccess`) is macOS 15.1+, not supervised-only,
  MDM-only (`allowmanualinstall: false`) and refused under User
  Enrollment, per Apple's device-management schema. So a whole-Mac
  enrollment approved by hand works: no wipe, nothing needed from
  MacStadium.
- [x] First access (2026-11-05): password changed (1Password), Homebrew,
  Tailscale as a system daemon (hostname `mac-bench`, 100.77.135.13),
  mosh (`brew shellenv` in `~/.zshenv`, so non-interactive shells find
  `mosh-server`; the firewall is off), Kevin's and the VM's keys. SSH is
  keys only (`/etc/ssh/sshd_config.d/100-keys-only.conf`), still open on
  the public address as the way back in if Tailscale fails.
- [x] Checked on the Mac: FileVault off, screen sharing on (reach it as
  `vnc://mac-bench` over Tailscale), sleep off, and a real audio device
  ("Mac mini Speakers").
- [x] Auto-login as `administrator`; a fresh login keychain ("Keychain
  Not Found" → Restore to Defaults); a restart came back logged in with
  Dorico reopened.
- [x] Dorico Elements 6.2.31 installed and activated (second Steinberg
  activation); Local Network allowed for Dorico, VSTAudioEngine6 and
  MediaBay, refused for the Download Assistant; no passwords saved in
  the keychain; Remote Control on, port 4560.
- [x] Bun 1.4.4, mac-bench cloned (tests 40/40 there), `.env.local`
  (mode 600), the launchd agent; Kevin clicked Allow. Dorico checks run
  from the VM against it (`MAC_BENCH_URL` default now `mac-bench`).
  Its PDFs are A4 (the Mac's region is Ireland); set Dorico's default
  paper size to Letter to match the MacBook if wanted.
- [ ] Choose an MDM: research ([docs/research/2026-11-05-mdm.md](research/2026-11-05-mdm.md))
  recommends **SimpleMDM** (about $3 a month for one Mac, 30-day trial):
  custom profiles, Apps and Books assigned to the device, enrollment by
  link; confirm those in the trial. Runner-up Jamf Now. Apple's own MDM in
  the merged "Apple Business" (April 2026) needs a Managed Apple Account
  signed in on a hand-enrolled Mac, which we chose to avoid. Logic Pro
  ($199.99) needs macOS 26.1 or later; check that US-bought licences
  install on the Mac in Ireland.
- [ ] Write the setup script in this repo: Homebrew bundle (Tailscale as
  a system daemon, BlackHole, Bun, git), clone, `.env.local` from
  1Password, the launchd agent; plus the settings that can't be scripted
  (auto-login with FileVault off, Dorico's Remote Control, the MDM
  profile).
- [ ] Write the "before you cancel" checklist: deactivate Dorico in
  Steinberg's Activation Manager, deauthorize Ableton, remove the Mac
  from the MDM, then cancel.
## Next: pick up here

Dorico is done (above). Left for the DAWs, in order:

1. **SimpleMDM trial** (Kevin): sign up; in Apple Business, create the
   MDM server and download its token for SimpleMDM, and connect an
   Apps and Books content token (Apple suggests a dedicated managed
   account for tokens, so a password change doesn't break them).
2. **Enroll the Mac by hand** with SimpleMDM's enrollment link, approving
   it in System Settings on the Mac (screen sharing).
3. **Push the screen-recording setting:** a custom profile with
   Restrictions (`com.apple.applicationaccess`)
   `forceBypassScreenCaptureAlert = true`. Check it lands and the
   monthly prompt stops.
4. **Logic Pro** ($199.99, macOS 26.1 or later): buy one licence in Apple
   Business → Apps and Books (card accepted), assign it to the Mac in
   SimpleMDM, install. Confirm a US-bought licence installs on the Mac in
   Ireland. Then open Logic once over screen sharing to download its
   essential sounds and clear its first-run prompts.
5. **Ableton Live: buy a licence.** Kevin has only ever had a trial, so
   nothing is authorized anywhere yet. To decide: which edition (Intro,
   Standard or Suite: the converter tests may need Suite's devices to
   open real-world projects), and whose account it's bought on (a
   Lightning Jar account, to match keeping the cloud Mac off personal
   accounts). Then install from ableton.com, authorize it on the cloud Mac
   (one of the licence's two authorizations), and open it once to clear
   first-run prompts (Local Network, audio device, any downloads).
6. **First DAW automation spike:** what Stem Shovel's converter tests need
   from each DAW (open a project, export or bounce, read results), and
   how to drive them (AppleScript or UI scripting, Ableton's Remote
   Scripts, Logic's limits). Plan it like the Dorico checks: spike,
   design, then build.

## Later
- [ ] Rebuild it once from the script early, before anything depends on it.
- [ ] Free the MacBook: Remote Login off; the helper can stay or be
  removed (`launchctl bootout gui/$UID/dev.lj.mac-bench`); deactivate
  Dorico there only if the three Steinberg activations run short.

## Licences on the cloud Mac

- Dorico: one of three Steinberg activations.
- Ableton Live: to be bought (Kevin had only a trial); the cloud Mac
  takes one of the new licence's two authorizations.
- Logic Pro: Lightning Jar's own copy, assigned to the device.
