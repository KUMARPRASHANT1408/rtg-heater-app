// Admin user management. Admins decide who is Admin, Local, HOD, RTG Chief or FM Chief.

function listUsers() {
  return readTable('Users').map(publicUser);
}

// Creates a user (returns a temporary password) or updates an existing one.
function saveUser(admin, data) {
  var userId = String(data.UserID || '').trim();
  if (!userId) throw new Error('User ID is required.');
  if (!data.Name) throw new Error('Name is required.');
  if (ROLES.indexOf(data.Role) < 0) throw new Error('Unknown role: ' + data.Role);

  var fields = { Name: data.Name, EmployeeID: data.EmployeeID || '', Email: data.Email || '', Role: data.Role,
                 Team: data.Team || '', Department: data.Department || '', Phone: data.Phone || '',
                 Active: data.Active === false ? false : true };
  var existing = findOne('Users', 'UserID', userId);
  if (existing) {
    if (existing.UserID === admin.UserID && (fields.Role !== 'Admin' || !fields.Active)) {
      throw new Error('You cannot remove your own admin access.');
    }
    updateWhere('Users', 'UserID', userId, fields);
    audit(admin.UserID, 'updateUser', userId, fields);
    return { user: publicUser(findOne('Users', 'UserID', userId)) };
  }
  var temp = randomPassword();
  var salt = newSalt();
  var row = Object.assign({ UserID: userId, Salt: salt, PasswordHash: hashPassword(temp, salt), MustChangePassword: true, CreatedOn: new Date() }, fields);
  appendRow('Users', row);
  audit(admin.UserID, 'createUser', userId, fields);
  return { user: publicUser(row), tempPassword: temp };
}

function resetPassword(admin, userId) {
  var u = findOne('Users', 'UserID', userId);
  if (!u) throw new Error('No such user.');
  var temp = randomPassword();
  var salt = newSalt();
  updateWhere('Users', 'UserID', userId, { Salt: salt, PasswordHash: hashPassword(temp, salt), MustChangePassword: true });
  audit(admin.UserID, 'resetPassword', userId);
  return { tempPassword: temp };
}
