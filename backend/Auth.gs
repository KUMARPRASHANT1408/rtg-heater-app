// Login with the app's own user IDs. Passwords are stored as salted SHA-256 hashes, never in plain text.

var SESSION_SECONDS = 6 * 60 * 60; // Apps Script cache maximum
var MAX_FAILED_LOGINS = 5;
var ROLES = ['Admin', 'Local', 'HOD', 'RTG Chief', 'FM Chief'];

function hashPassword(password, salt) {
  var value = salt + ':' + password;
  for (var i = 0; i < 50; i++) {
    value = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
  }
  return value;
}

function newSalt() {
  return Utilities.getUuid().replace(/-/g, '');
}

function randomPassword() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  var out = '';
  for (var i = 0; i < 10; i++) out += chars.charAt((raw[i] + 256) % chars.length);
  return out;
}

function publicUser(u) {
  return { UserID: u.UserID, Name: u.Name, EmployeeID: u.EmployeeID, Email: u.Email, Role: u.Role, Team: u.Team,
           Department: u.Department, Phone: u.Phone, Active: u.Active, MustChangePassword: u.MustChangePassword === true || u.MustChangePassword === 'TRUE' };
}

function login(userId, password) {
  userId = String(userId || '').trim();
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + userId.toLowerCase();
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILED_LOGINS) throw new Error('Too many failed attempts. Try again in 15 minutes.');

  var u = readTable('Users').filter(function (x) { return String(x.UserID).toLowerCase() === userId.toLowerCase(); })[0];
  if (!u || !isActive_(u) || hashPassword(String(password || ''), u.Salt) !== u.PasswordHash) {
    cache.put(failKey, String(fails + 1), 15 * 60);
    throw new Error('Wrong user ID or password.');
  }
  cache.remove(failKey);
  var token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  cache.put('sess:' + token, u.UserID, SESSION_SECONDS);
  audit(u.UserID, 'login');
  return { token: token, user: publicUser(u) };
}

function logout(token) {
  CacheService.getScriptCache().remove('sess:' + token);
  return { ok: true };
}

function isActive_(u) {
  return u.Active === true || u.Active === 'TRUE' || u.Active === 'Y';
}

// Returns the logged-in user, or throws. Pass roles to restrict an action.
function requireUser(token, roles, teams) {
  var cache = CacheService.getScriptCache();
  var userId = token && cache.get('sess:' + token);
  if (!userId) throw new AuthError('Session expired. Please log in again.');
  var u = findOne('Users', 'UserID', userId);
  if (!u || !isActive_(u)) throw new AuthError('Account disabled.');
  if (roles && roles.indexOf(u.Role) < 0 && !(teams && teams.indexOf(u.Team) >= 0)) throw new Error('You do not have permission for this.');
  cache.put('sess:' + token, userId, SESSION_SECONDS); // sliding expiry
  return u;
}

function AuthError(message) {
  this.message = message;
  this.auth = true;
}
AuthError.prototype = Object.create(Error.prototype);

function changePassword(user, oldPassword, newPassword) {
  if (hashPassword(String(oldPassword || ''), user.Salt) !== user.PasswordHash) throw new Error('Current password is wrong.');
  if (String(newPassword || '').length < 8) throw new Error('New password must be at least 8 characters.');
  var salt = newSalt();
  updateWhere('Users', 'UserID', user.UserID, { Salt: salt, PasswordHash: hashPassword(newPassword, salt), MustChangePassword: false });
  audit(user.UserID, 'changePassword');
  return { ok: true };
}
