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
  service (MDM), and Logic is bought through Apps and Books. The MDM
  also stops macOS 15's monthly screen-recording prompt. (How the Mac is
  enrolled changed on 2026-11-20: see below.)
- **Rebuildable, not backed up.** The Mac can be cancelled and rented
  again later: everything comes from a setup script, GitHub and
  1Password, and nothing important lives only on the Mac.
- **A future Stem Shovel native app** (e.g. a project-sync helper) is
  built, signed and notarised in GitHub Actions; signing keys never go on
  the test Mac. Clean-install and upgrade tests run in macOS VMs on it
  (two per Mac under Apple's licence); integration tests with the DAWs
  run on the Mac itself.

## Decided (Kevin, 2026-11-20): a managed account on the Mac, and Apple Developer

This replaces "no Apple ID is signed in" and the SimpleMDM choice below.

- **A Managed Apple Account is the Mac's Apple ID.** Signing it in
  enrols the Mac in Apple Business's own free device management
  (account-driven Device Enrollment: no wipe, macOS 14.1 or later, and
  the Mac becomes supervised), so no SimpleMDM. Apps come from the Apple
  Business app, assigned to the user. Still no personal Apple ID or
  personal iCloud on the Mac.
- **Managed accounts live on `lj.dev`,** not `lightningjar.com`.
  `lightningjar.com` has 18 personal Apple IDs on it, and Domain Capture
  (which can't be undone) would make each of them move or rename;
  `lj.dev` has none and has working mail (Proton). `lj.dev`'s DNS is at
  Vercel; only `bench.lj.dev` is at DigitalOcean. Domain Capture is on
  for `lj.dev` (Kevin, 2026-11-20; it cannot be undone): the domain is
  locked, so no new personal Apple ID can be made on it, and any that
  existed had 30 days to move or rename. Never turn it on for
  `lightningjar.com`.
- **Two managed accounts.** Kevin's own is the organisation's
  administrator and the Apple Developer Program's Account Holder. A
  second, for the machine, is the Apple ID on mac-bench and joins the
  developer team with a limited role. The machine account is never an
  administrator or the Account Holder.
- **The Apple Developer Program membership already exists,** under
  Kevin's personal Apple ID: no second enrolment. The managed accounts
  are invited to its team. That needs an organisation membership (an
  individual one gives invited users App Store Connect only, no
  certificates), so an individual membership is first converted to the
  organisation, whose legal name the App Store then shows as the seller.
  The Account Holder role can stay on the personal Apple ID; moving it to
  Kevin's managed account is optional and can wait.
- **mac-bench builds, tests, signs and uploads the iOS app** (Kevin,
  2026-11-20). This replaces "signing keys never go on the test Mac" for
  this app. To keep the exposure small, signing is cloud-managed: Apple
  holds the distribution certificate's private key, and the Mac holds
  only a credential that can be revoked at once. First choice: the
  machine's managed account signed in to Xcode, with a limited role and
  "Access to Cloud Managed Distribution Certificate". Fallback, if that
  cannot run unattended (Xcode's sign-in expires and asks for a code): an
  App Store Connect API key, which must be an **Admin** key for cloud
  signing, kept in 1Password and fetched for the job through varlock,
  never in this repo. No exported `.p12` on the Mac either way. A spike
  decides between the two. (The Mac's disk is not encrypted, FileVault
  being off for auto-login, so whatever it can reach is only as safe as
  MacStadium's room: the reason for revocable credentials.)

What Apple's pages say, checked 2026-11-20 (links in the 2026-11-20
section of the research notes are the Apple Business guide's "service
access", "enrollment methods" and "access management" pages):

- A Managed Apple Account can sign up for the Developer Program or join
  a team, and can use App Store Connect, Xcode Cloud and TestFlight, but
  only once an administrator allows it: Settings > Access Management >
  Apple Services > Developer. It is off by default.
- The App Store is browse-only for a managed account (no purchases, free
  apps included): Xcode comes through Apps and Books or from
  developer.apple.com.
- TestFlight needs an address that can receive email, so not the
  reserved domain (`…appleaccount.com`).
- Each service can be limited to "managed devices only".
- A hand-enrolled Mac takes Blueprints assigned to the **user**; device
  Blueprints need Automated Device Enrollment.

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
- [x] Domain (2026-11-20): `lj.dev` added to Apple Business and verified
  (a TXT record at Vercel). The unverified website address Apple had on
  file from the application had no accounts on it; Apple's notice about
  it (update by 2026-12-03) needs nothing more, and that domain can be
  removed. Kevin's administrator account now signs in on `lj.dev`.
- [x] MDM chosen (2026-11-20): Apple Business's built-in device
  management, with the machine's managed account signed in. Superseded:
  research ([docs/research/2026-11-05-mdm.md](research/2026-11-05-mdm.md))
  had recommended **SimpleMDM** (about $3 a month for one Mac, 30-day trial):
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
  Steinberg's Activation Manager, deauthorize Ableton, sign the machine
  account out and remove the Mac from Apple Business's device
  management, then cancel.
## Next: pick up here

Dorico is done (above). In order; **K** is Kevin's, in Apple's consoles
or on the Mac's screen, **C** is Claude's, over SSH or in this repo.

### Accounts and Apple Developer

1. **K** Mail: make sure every managed account's sign-in name receives
   mail on `lj.dev` (an alias in Proton is enough), the administrator's
   included.
2. **K** Apple Business > Settings > Access Management > Apple Services
   > Developer: allow the Apple Developer Program.
3. **K** The existing Developer Program membership (under the personal
   Apple ID): look at developer.apple.com/account > Membership details
   for its type. **Organisation:** nothing to do here. **Individual:**
   convert it to the organisation (Membership > update an individual
   membership to an organisation, or Apple Developer Support), with the
   legal entity and D-U-N-S number exactly as on the D-U-N-S record;
   Apple's check takes days to weeks, and the seller name becomes the
   legal entity's.
4. **K** Create the machine's managed account on `lj.dev` (a mailbox or
   alias first), with a plain staff role and a trusted phone number
   Kevin controls for its sign-in codes. Limit it to managed devices
   only and turn off the services it does not need (Access Management).
5. **K** In App Store Connect > Users and Access (the membership being
   an organisation's): invite Kevin's managed account as Admin, and the
   machine account with a limited role (Developer, or App Manager if
   uploads need it), with access to Certificates, Identifiers & Profiles
   and "Access to Cloud Managed Distribution Certificate". Each accepts
   the invitation from its `lj.dev` mailbox.

### Enrolling the Mac

6. **K** Apple Business > Devices > Management Services > Device
   Enrollment: choose "Enroll as an organization-owned device" for Mac.
7. **K** Make a Blueprint for the machine account: a custom
   configuration with Restrictions (`com.apple.applicationaccess`)
   `forceBypassScreenCaptureAlert = true` (**C** writes the
   `.mobileconfig`), and the apps below.
8. **K** On the Mac, over screen sharing: sign the machine account in
   (System Settings; decline every offer to save a password, and leave
   the iCloud services off) and approve the enrolment.
9. **C** Check over SSH: `profiles status -type enrollment` shows the
   enrolment, the Mac is supervised, the custom configuration is
   installed, and the monthly screen-recording prompt has stopped.
10. To confirm in the console, not yet known: that a custom
    configuration reaches a hand-enrolled Mac through a user Blueprint,
    and whether the reserved domain would have worked for enrolment
    (not needed now).

### Apps

11. **K** Xcode: assign it through Apps and Books (free), or download it
    from developer.apple.com. **C** then installs the simulators and
    sets up the iOS project's checks, as the Dorico checks were.
12. **K** Logic Pro ($199.99, macOS 26.1 or later): buy one licence in
    Apps and Books, assign it to the machine account, install it from
    the Apple Business app. Confirm a US-bought licence installs on the
    Mac in Ireland. Open it once over screen sharing for its sounds and
    first-run prompts.
13. **Ableton Live: buy a licence.** Kevin has only ever had a trial, so
    nothing is authorized anywhere yet. To decide: which edition (Intro,
    Standard or Suite: the converter tests may need Suite's devices to
    open real-world projects), and whose account it's bought on (a
    Lightning Jar account). Then install from ableton.com, authorize it
    on the cloud Mac (one of the licence's two authorizations), and open
    it once to clear first-run prompts.
14. **First DAW automation spike:** what Stem Shovel's converter tests
    need from each DAW (open a project, export or bounce, read results),
    and how to drive them. Plan it like the Dorico checks: spike,
    design, then build.

### The iOS app: build, test, sign and upload on mac-bench

15. **K** Sign the machine account in to Xcode on the Mac (Settings >
    Accounts), over screen sharing.
16. **C** Spike, on a throwaway app ID: `xcodebuild` build and simulator
    tests; an archive with automatic, cloud-managed signing
    (`-allowProvisioningUpdates`); an upload to App Store Connect. Find
    out how long Xcode's sign-in lasts unattended, and whether the
    machine account's role is enough. If it is not workable, the
    fallback is an Admin App Store Connect API key from 1Password
    (`-authenticationKeyPath`, `-authenticationKeyID`,
    `-authenticationKeyIssuerID`), which Kevin creates.
17. **C** Then design and build the job as the Dorico checks were: a
    `mac-bench` command the VM calls, one job at a time, logs back to
    the VM, nothing secret in this repo.

## Later
- [ ] Rebuild it once from the script early, before anything depends on it.
- [ ] Free the MacBook: Remote Login off; the helper can stay or be
  removed (`launchctl bootout gui/$UID/dev.lj.mac-bench`); deactivate
  Dorico there only if the three Steinberg activations run short.

## Licences on the cloud Mac

- Dorico: one of three Steinberg activations.
- Ableton Live: to be bought (Kevin had only a trial); the cloud Mac
  takes one of the new licence's two authorizations.
- Logic Pro: the organisation's own copy, assigned to the machine's
  managed account.
