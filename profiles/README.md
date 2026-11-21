# Configuration profiles for the cloud Mac

Uploaded by hand to Apple Business (Devices > Configurations > Custom) and
attached to the machine account's Blueprint. Nothing here is secret.

- `screen-capture.mobileconfig`: Restrictions
  (`com.apple.applicationaccess`) `forceBypassScreenCaptureAlert = true`,
  so macOS stops asking each month whether apps already allowed to record
  the screen may continue. It only works through device management
  (macOS 15.1 or later): installing the file by hand does nothing.
