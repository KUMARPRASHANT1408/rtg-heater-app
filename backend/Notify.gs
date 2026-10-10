// All mail to people goes out from company mail. This script only mails ONE company inbox
// (Settings: CompanyInbox); a Power Automate flow reads the attached rtg-notify.json and sends the real mail.
// The mail itself shows the readable message, so the inbox copy is easy to read too.

function queueMail(type, ref, to, cc, subject, html) {
  var payload = { type: type, ref: ref, to: to || '', cc: cc || '', subject: subject, html: html };
  var inbox = getSetting('CompanyInbox', '');
  var status = 'Logged only (CompanyInbox not set)';
  if (inbox) {
    var json = JSON.stringify(payload);
    MailApp.sendEmail({
      to: inbox,
      subject: '[RTG-NOTIFY] ' + type + ' ' + ref,
      body: json,
      htmlBody: '<p style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#718096;margin:0 0 14px">' +
        'Copy for the RTG inbox. Power Automate sends this to: ' + escHtml_(payload.to || '(nobody)') + (payload.cc ? ' · CC: ' + escHtml_(payload.cc) : '') + '</p>' + html,
      attachments: [Utilities.newBlob(json, 'application/json', 'rtg-notify.json')]
    });
    status = 'Sent to company inbox';
  }
  appendRow('MailOutbox', { Time: new Date(), Type: type, Ref: ref, To: payload.to, CC: payload.cc, Subject: subject, Status: status });
  return status;
}
