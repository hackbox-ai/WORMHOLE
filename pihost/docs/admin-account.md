# Administrator account

You can set the user name and password during the first initialization; existing instances without a user name will continue to use WORMHOLE and the account will not be automatically reset.
Enter the new username and current password in "Account → Modify Username" to modify it, and the password remains unchanged.
After renaming, the old username cannot be used for new logins; valid sessions that have been issued continue to be available, and the account name is synchronized from the server.
Username supports 2–48 Chinese characters, letters, numbers and . _ @ -, leading and trailing spaces will be removed, Unicode uses NFC normalization.

GET /api/auth/account requires a valid login and returns the current username.
PATCH /api/auth/account requires a valid login and current_password, modifies username and returns new token.
The username of POST /api/auth/init is optional. When omitted, the default initialization behavior is retained; the username and password are written atomically, and repeated initialization does not overwrite existing accounts.
This function manages an administrator account and does not add new users, roles or tenant systems.

Regression: tests/auth-username.test.ts covers old instance compatibility, authentication, current password verification, Chinese username, restart persistence and initialization competition.
