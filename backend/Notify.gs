// All mail to people goes out from company mail. This script only mails ONE company inbox
// (Settings: CompanyInbox); a Power Automate flow reads the JSON body and sends the real mail.

function queueMail(type, ref, to, cc, subject, html) {
  var payload = { type: type, ref: ref, to: to || '', cc: cc || '', subject: subject, html: html };
  var inbox = getSetting('CompanyInbox', '');
  var status = 'Logged only (CompanyInbox not set)';
  if (inbox) {
    MailApp.sendEmail({
      to: inbox,
      subject: '[RTG-NOTIFY] ' + type + ' ' + ref,
      body: JSON.stringify(payload)
    });
    status = 'Sent to company inbox';
  }
  appendRow('MailOutbox', { Time: new Date(), Type: type, Ref: ref, To: payload.to, CC: payload.cc, Subject: subject, Status: status });
  return status;
}
