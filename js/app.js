/* HoloRec router: ?mode=desktop | ?mode=phone&room=CODE | landing picker. */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

async function go() {
  if (mode === 'desktop') {
    const m = await import('./desktop.js?v=3');
    m.initDesktop(room || null);
  } else if (mode === 'phone') {
    const m = await import('./phone.js?v=3');
    m.initPhone(room || null);
  } else {
    document.querySelectorAll('main').forEach((x) => { x.style.display = 'none'; });
    $('landing').style.display = '';
    $('go-desktop').onclick = () => { location.search = '?mode=desktop'; };
    $('go-phone').onclick = () => {
      const code = $('join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      location.search = '?mode=phone' + (code ? '&room=' + code : '');
    };
    if (room) { $('join-code').value = room; }
  }
}
go();
