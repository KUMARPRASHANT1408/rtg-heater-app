// Heater search and reference lists.

function heaterData_() {
  return { models: readTable('HeaterModels'), types: readTable('ComponentTypes'), components: readTable('Components'), guide: readTable('HeaterSelection') };
}

function apiHeaterSearch(data) {
  return heaterSearch(heaterData_(), data.width, data.rating, data.plies);
}

function apiLookups() {
  return {
    conveyors: readTable('Conveyors'),
    departments: readTable('Departments').map(function (d) { return d.Department; }),
    models: readTable('HeaterModels'),
    guide: readTable('HeaterSelection')
  };
}

// Component-level stock list for the admin heater inventory screen.
function apiComponents(data) {
  var rows = readTable('Components');
  if (data && data.modelId) rows = rows.filter(function (c) { return c.ModelID === data.modelId; });
  return rows;
}
