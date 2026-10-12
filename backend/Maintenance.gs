// Heater maintenance by the RTG team: they log which parts they maintained each day and attach the
// filled checklist; the RTG team verifies the log, and only then the parts become ready to issue again.

var MLOG = { SUBMITTED: 'Submitted', VERIFIED: 'Verified', REJECTED: 'Rejected' };
var CHECKLIST_MAX_BYTES = 6 * 1024 * 1024;
var CHECKLIST_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Folder in the owner's Google Drive for checklist files. Created on first use (or by setup).
function checklistFolder_() {
  var id = getSetting('ChecklistFolderId', '');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make a new one */ }
  }
  var folder = DriveApp.createFolder('RTG Heater Management - maintenance checklists');
  if (findOne('Settings', 'Key', 'ChecklistFolderId')) updateWhere('Settings', 'Key', 'ChecklistFolderId', { Value: folder.getId() });
  else appendRow('Settings', { Key: 'ChecklistFolderId', Value: folder.getId(), Notes: 'Google Drive folder for maintenance checklists (made automatically).' });
  return folder;
}

function pendingLogIds_(logs) {
  var ids = {};
  logs.filter(function (l) { return l.Status === MLOG.SUBMITTED; }).forEach(function (l) {
    parseList_(l.ComponentIDs).forEach(function (id) { ids[id] = l.LogNo; });
  });
  return ids;
}

// Every part in the store that can be maintained: "due" after a joint, or due for routine maintenance.
// Each says whether a log for it is already waiting for RTG.
function maintenanceDue(user) {
  if (!isRtgTeam_(user)) throw new Error('You do not have permission for this.');
  var models = {}, pairs = {};
  readTable('HeaterModels').forEach(function (m) { models[m.ModelID] = m.ModelName; pairs[m.ModelID] = splitIds_(m.MadeFrom).join(' + '); });
  var pending = pendingLogIds_(readTable('MaintenanceLogs'));
  return readTable('Components').filter(function (c) { return c.Status === STATUS.IN_STORE && c.Condition !== CONDITION.SCRAPPED; })
    .map(function (c) {
      return { ComponentID: c.ComponentID, ModelID: c.ModelID, ModelName: models[c.ModelID] || c.ModelID, SetNo: c.SetNo, ComponentName: c.ComponentName,
               PairOf: pairs[c.ModelID] || '', Condition: c.Condition, due: c.MaintenanceStatus === MAINT.DUE, LastInspected: c.LastInspected, JointsSinceMaintenance: c.JointsSinceMaintenance, Remarks: c.Remarks, pendingLog: pending[c.ComponentID] || '' };
    });
}

function logMaintenance(user, d) {
  if (!isRtgTeam_(user)) throw new Error('You do not have permission for this.');
  var ids = parseList_(d.ComponentIDs);
  if (!ids.length) throw new Error('Choose the parts you maintained.');
  required_(d, [['WorkDone', 'Work done']]);
  var date = String(d.LogDate || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) throw new Error('Choose today or an earlier date.');
  var file = d.file || {};
  if (!file.data) throw new Error('Attach the filled checklist (photo or PDF).');
  if (CHECKLIST_TYPES.indexOf(file.type) < 0) throw new Error('The checklist must be a photo (JPG or PNG) or a PDF.');
  if (String(file.data).length * 0.75 > CHECKLIST_MAX_BYTES) throw new Error('The checklist file is too big. Please keep it under 6 MB.');
  var due = {};
  maintenanceDue(user).forEach(function (c) { due[c.ComponentID] = c; });
  ids.forEach(function (id) {
    if (!due[id]) throw new Error(id + ' is not in the store, so it cannot be logged.');
    if (due[id].pendingLog) throw new Error(id + ' is already in log ' + due[id].pendingLog + ', waiting for RTG to verify.');
  });
  var repaired = parseList_(d.RepairedIDs).filter(function (id) { return ids.indexOf(id) >= 0 && due[id].Condition !== CONDITION.OK; });
  var no = nextNumber('mlog', 'MNT');
  var name = no + ' checklist ' + date + '.' + (file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1].replace('jpeg', 'jpg'));
  var saved = checklistFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(file.data), file.type, name));
  appendRow('MaintenanceLogs', { LogNo: no, LogDate: date, LoggedBy: user.UserID, LoggedOn: new Date(), VendorTeam: d.VendorTeam || user.Department || '',
                                 ComponentIDs: JSON.stringify(ids), RepairedIDs: JSON.stringify(repaired), WorkDone: d.WorkDone,
                                 ChecklistFileId: saved.getId(), ChecklistName: name, ChecklistType: file.type, Status: MLOG.SUBMITTED });
  audit(user.UserID, 'logMaintenance', no, { parts: ids.length });
  queueMail('MAINTENANCE_LOGGED', no, getSetting('RTGTeamMail', ''), '', 'Heater maintenance logged: ' + no + ' (' + ids.length + ' parts)',
    mailHtml_('Maintenance logged by ' + user.Name, [['Log', no], ['Date', date], ['Work done', d.WorkDone]]
      .concat(ids.map(function (id) { return [id, due[id].ComponentName + (repaired.indexOf(id) >= 0 ? ' (repaired)' : '')]; })),
      'Please check the parts and the checklist in the app, then verify the log so the parts can be issued again.'));
  return { LogNo: no };
}

function listMaintenanceLogs(user) {
  if (!isRtgTeam_(user)) throw new Error('You do not have permission for this.');
  var users = {};
  readTable('Users').forEach(function (u) { users[u.UserID] = u.Name; });
  var names = {};
  readTable('Components').forEach(function (c) { names[c.ComponentID] = c.ComponentName; });
  return readTable('MaintenanceLogs').map(function (l) {
    var ids = parseList_(l.ComponentIDs);
    return { LogNo: l.LogNo, LogDate: l.LogDate, LoggedBy: l.LoggedBy, LoggedByName: users[l.LoggedBy] || l.LoggedBy, LoggedOn: l.LoggedOn, VendorTeam: l.VendorTeam,
             parts: ids.map(function (id) { return { ComponentID: id, ComponentName: names[id] || '' }; }), repaired: parseList_(l.RepairedIDs),
             WorkDone: l.WorkDone, ChecklistName: l.ChecklistName, Status: l.Status, VerifiedBy: users[l.VerifiedBy] || l.VerifiedBy, VerifiedOn: l.VerifiedOn, RTGRemark: l.RTGRemark };
  }).reverse();
}

function getChecklist(user, d) {
  if (!isRtgTeam_(user)) throw new Error('You do not have permission for this.');
  var l = findOne('MaintenanceLogs', 'LogNo', d.LogNo);
  if (!l || !l.ChecklistFileId) throw new Error('No checklist for this log.');
  var blob = DriveApp.getFileById(l.ChecklistFileId).getBlob();
  return { name: l.ChecklistName, type: l.ChecklistType, data: Utilities.base64Encode(blob.getBytes()) };
}

// RTG checks the parts and the checklist. Approving puts the parts back in service.
function verifyMaintenance(admin, d) {
  var l = findOne('MaintenanceLogs', 'LogNo', d.LogNo);
  if (!l) throw new Error('No such log.');
  if (l.Status !== MLOG.SUBMITTED) throw new Error('This log is already ' + String(l.Status).toLowerCase() + '.');
  var logger = findOne('Users', 'UserID', l.LoggedBy);
  var to = logger && logger.Email ? logger.Email : '';
  if (d.decision === 'reject') {
    if (!String(d.remark || '').trim()) throw new Error('Say what is wrong so the vendor can redo it.');
    updateWhere('MaintenanceLogs', 'LogNo', l.LogNo, { Status: MLOG.REJECTED, VerifiedBy: admin.UserID, VerifiedOn: new Date(), RTGRemark: d.remark });
    queueMail('MAINTENANCE_REJECTED', l.LogNo, to, getSetting('RTGTeamMail', ''), 'Maintenance log ' + l.LogNo + ' not accepted',
      mailHtml_('Maintenance log ' + l.LogNo + ' was not accepted by RTG', [['Date', l.LogDate], ['Reason', d.remark]], 'Please redo the maintenance and log it again.'));
    audit(admin.UserID, 'rejectMaintenance', l.LogNo);
    return { status: MLOG.REJECTED };
  }
  if (d.decision !== 'approve') throw new Error('Unknown decision.');
  var ids = parseList_(l.ComponentIDs), repaired = parseList_(l.RepairedIDs);
  var comps = {};
  readTable('Components').forEach(function (c) { comps[c.ComponentID] = c; });
  var patches = {};
  ids.forEach(function (id) {
    var c = comps[id];
    if (!c || c.Status !== STATUS.IN_STORE) return; // issued or missing since: leave it alone
    var p = { MaintenanceStatus: MAINT.OK, JointsSinceMaintenance: 0, LastInspected: String(l.LogDate).slice(0, 10) };
    if (repaired.indexOf(id) >= 0 && c.Condition !== CONDITION.SCRAPPED) p.Condition = CONDITION.OK;
    patches[id] = p;
  });
  updateMany('Components', 'ComponentID', patches);
  updateWhere('MaintenanceLogs', 'LogNo', l.LogNo, { Status: MLOG.VERIFIED, VerifiedBy: admin.UserID, VerifiedOn: new Date(), RTGRemark: d.remark || '' });
  audit(admin.UserID, 'verifyMaintenance', l.LogNo, { parts: Object.keys(patches).length });
  return { status: MLOG.VERIFIED, parts: Object.keys(patches).length };
}
