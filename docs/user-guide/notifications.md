# Notice

## Page reminder

When a new vulnerability is discovered and stored in the database, a reminder can be displayed on the page, and a ringtone can be played according to the browser settings. The reminder in the lower right corner is related to the current browser preference; the first playback may be restricted by the browser sound policy.

## Configure external channels

Create a channel in the notification, fill in the address and credentials of the corresponding service, set the activation status, push scope and real-time or summary mode, and save it after the test is successful.

The external notification master switch, channel switch and filter conditions jointly determine whether to send. Existing channel types cannot be modified. If you need to use other types, create a new channel.

## Range and current limit

Filter by level, type, task, and asset. Type keywords, one per line, use case-insensitive substring matching; exclusion conditions take precedence over inclusion. Leave tasks and assets blank to indicate no limit.

Leave the current limit blank to use the channel default value, 0 means no current limit. Messages that exceed the limit will be sent later. The summary interval is set in minutes and only takes effect in summary mode.

## High-risk emails

Fill in the SMTP, sender and recipient email addresses in the system configuration, and check the external notification master switch. High-risk and serious vulnerabilities will be pushed when they are added to the database or upgraded, and the same vulnerability will be processed according to the deduplication rules.

The details link uses the configured site address. Test emails are used to verify delivery links, and actual discovery notifications are also controlled by events, levels, and deduplication conditions. View delivery records and service returns when troubleshooting.
