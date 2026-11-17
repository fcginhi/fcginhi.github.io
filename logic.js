/* =====================================================================
   FC GÌ NHỈ – LOGIC DÙNG CHUNG
   File này dùng ở 2 nơi, nội dung giữ y hệt nhau:
   - GitHub: logic.js (để app chạy bản xem thử)
   - Google Apps Script: file Logic.gs
   ===================================================================== */
var FC = (function () {
  var H7 = 7 * 3600 * 1000; // giờ Việt Nam = UTC+7

  var DEF = {
    teamName: 'FC Gì Nhỉ', defaultTime: '18:00', defaultPlace: '',
    duesAmount: 150000, feeAmount: 30000, noVoteFine: 10000, absentFine: 30000,
    fineStart: '2026-11-29',
    tanName: 'Huỳnh Tân', tanBank: 'VCB', tanAcc: '0541000346487', tanHolder: 'TRIEU HUYNH TAN',
    ducName: 'Phạm Đức', ducBank: 'TCB', ducAcc: '283004199999', ducHolder: 'PHAM LUONG DUC'
  };
  var PUBLIC_KEYS = Object.keys(DEF);

  var TABLES = {
    players: ['id', 'name', 'number', 'pinHash', 'salt', 'active', 'createdAt', 'rest'],
    matches: ['id', 'date', 'time', 'opponent', 'place', 'status', 'gf', 'ga', 'fieldCost', 'snap', 'source'],
    votes: ['matchId', 'playerId', 'vote', 'ts'],
    snaps: ['matchId', 'playerId', 'vote'],
    charges: ['id', 'playerId', 'matchId', 'quarter', 'date', 'type', 'amount', 'collector', 'status', 'paidAt', 'note'],
    goals: ['matchId', 'scorer', 'count', 'hidden'],
    txns: ['id', 'date', 'kind', 'cat', 'amount', 'holder', 'to', 'note', 'matchId'],
    attend: ['matchId', 'playerId', 'status'],
    wallet: ['id', 'playerId', 'date', 'kind', 'amount', 'chargeId', 'note'],
    claims: ['id', 'playerId', 'collector', 'items', 'topup', 'amount', 'status', 'createdAt', 'decidedAt', 'note']
  };
  var WALLET_TYPES = { fee: 1, absent: 1, novote: 1 }; // ví trừ tiền trận + tiền phạt (không trừ quỹ quý)

  /* ---------- tiện ích ngày giờ ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function vnParts(ms) { var d = new Date(ms + H7); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() }; }
  function today(now) { var o = vnParts(now); return o.y + '-' + pad(o.m) + '-' + pad(o.d); }
  function addDays(s, k) { var p = s.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + k)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function weekday(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }
  /* Hạn vote: 20:00 tối hôm trước ngày đá (thứ 7) */
  function deadline(date) { var p = date.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2] - 1, 20, 0) - H7; }
  function quarterOf(s) { var p = s.split('-'); return p[0] + '-Q' + (Math.floor((+p[1] - 1) / 3) + 1); }
  function num(x) { x = Number(x); return isFinite(x) ? x : 0; }
  function cfg(db, k) { var v = db.config[k]; return (v != null && v !== '') ? v : DEF[k]; }
  function find(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function iso(now) { return new Date(now).toISOString(); }
  /* Tạm nghỉ (chấn thương): rest = ngày nghỉ đến (yyyy-mm-dd), '9999-12-31' = đến khi bỏ */
  function resting(p, date) { return !!(p && p.rest && p.rest >= date); }

  function lastVote(db, mid, pid, until) {
    var r = null, rt = -1;
    for (var i = 0; i < db.votes.length; i++) {
      var v = db.votes[i];
      if (v.matchId !== mid || v.playerId !== pid) continue;
      var t = Date.parse(v.ts);
      if (until != null && t > until) continue;
      if (t >= rt) { r = v; rt = t; }
    }
    return r;
  }

  function newCharge(env, pid, mid, type, amount, collector, date) {
    return { id: env.uid(), playerId: pid, matchId: mid || '', quarter: quarterOf(date), date: date, type: type,
      amount: String(amount), collector: collector, status: 'unpaid', paidAt: '', note: '' };
  }

  /* ---------- ví trả trước: tự trừ tiền trận & phạt ---------- */
  function walletUsed(db, chargeId) {
    var t = 0; db.wallet.forEach(function (w) { if (w.kind === 'use' && w.chargeId === chargeId) t += num(w.amount); }); return t;
  }
  function applyWallet(db, now, env) {
    var ch = {}, byId = {};
    db.charges.forEach(function (c) { byId[c.id] = c; });
    // 1) khoản bị xóa / hủy → hoàn tiền về ví
    var n0 = db.wallet.length;
    db.wallet = db.wallet.filter(function (w) { return w.kind !== 'use' || (byId[w.chargeId] && byId[w.chargeId].status !== 'void'); });
    if (db.wallet.length !== n0) ch.wallet = 1;
    // 2) số dư từng người; nếu âm (xóa nhầm lần nạp) → bỏ bớt lần trừ mới nhất
    var bal = {};
    db.wallet.forEach(function (w) { bal[w.playerId] = (bal[w.playerId] || 0) + (w.kind === 'use' ? -num(w.amount) : num(w.amount)); });
    Object.keys(bal).forEach(function (pid) {
      while (bal[pid] < 0) {
        var last = null, li = -1;
        db.wallet.forEach(function (w, i) { if (w.playerId === pid && w.kind === 'use' && (!last || w.date >= last.date)) { last = w; li = i; } });
        if (li < 0) break;
        db.wallet.splice(li, 1); bal[pid] += num(last.amount); ch.wallet = 1;
      }
    });
    // 3) khoản ghi "trả bằng ví" mà ví không còn đủ → về chưa trả
    db.charges.forEach(function (c) {
      if (c.status === 'paid' && c.note === 'ví' && walletUsed(db, c.id) < num(c.amount)) { c.status = 'unpaid'; c.paidAt = ''; c.note = ''; ch.charges = 1; }
    });
    // 4) trừ ví cho các khoản chưa trả, cũ trước mới sau
    db.charges.filter(function (c) { return c.status === 'unpaid' && WALLET_TYPES[c.type] && (bal[c.playerId] || 0) > 0; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .forEach(function (c) {
        var b = bal[c.playerId] || 0; if (b <= 0) return;
        var used = walletUsed(db, c.id), remain = num(c.amount) - used, take = Math.min(b, remain);
        if (take > 0) { db.wallet.push({ id: env.uid(), playerId: c.playerId, date: c.date, kind: 'use', amount: String(take), chargeId: c.id, note: '' }); bal[c.playerId] = b - take; ch.wallet = 1; }
        if (used + take >= num(c.amount)) { c.status = 'paid'; c.paidAt = iso(now); c.note = 'ví'; ch.charges = 1; }
      });
    return ch;
  }

  /* ---------- việc tự động mỗi lần có người mở app ---------- */
  function ensure(db, now, env) {
    var ch = {};
    var t = today(now), w = weekday(t);
    var sun = (w === 0) ? t : addDays(t, 7 - w);

    // 1) Tự tạo trận chủ nhật tới
    if (!db.matches.some(function (m) { return m.date === sun; })) {
      db.matches.push({ id: env.uid(), date: sun, time: cfg(db, 'defaultTime'), opponent: '', place: cfg(db, 'defaultPlace'),
        status: 'open', gf: '', ga: '', fieldCost: '', snap: '', source: 'app' });
      ch.matches = 1;
    }

    // 2) Qua 20h T7: chụp lại kết quả vote + phạt người không vote
    db.matches.forEach(function (m) {
      if (m.status !== 'open' || m.snap === 'yes' || m.source === 'history') return;
      var dl = deadline(m.date);
      if (now < dl) return;
      db.players.forEach(function (p) {
        if (p.active === 'no' || Date.parse(p.createdAt) > dl) return;
        var v = lastVote(db, m.id, p.id, dl), val = v ? v.vote : '';
        db.snaps.push({ matchId: m.id, playerId: p.id, vote: val });
        if (!val && m.date >= cfg(db, 'fineStart') && !resting(p, m.date)) {
          db.charges.push(newCharge(env, p.id, m.id, 'novote', cfg(db, 'noVoteFine'), 'duc', m.date));
          ch.charges = 1;
        }
      });
      m.snap = 'yes'; ch.matches = 1; ch.snaps = 1;
    });

    // 3) Quỹ quý: mỗi thành viên 1 khoản / quý
    var q = quarterOf(t);
    db.players.forEach(function (p) {
      if (p.active === 'no') return;
      var has = db.charges.some(function (c) { return c.type === 'dues' && c.quarter === q && c.playerId === p.id; });
      if (!has) { db.charges.push(newCharge(env, p.id, '', 'dues', cfg(db, 'duesAmount'), 'tan', t)); ch.charges = 1; }
    });
    var wc = applyWallet(db, now, env); Object.keys(wc).forEach(function (k) { ch[k] = 1; });
    return ch;
  }

  /* ---------- các thao tác ---------- */
  function handle(db, a, p, now, env) {
    var ch = {}, res = {};
    function need(c, msg) { if (!c) throw new Error(msg); }
    function isAdmin() { return !!db.config.adminCode && String(p.admin || '') === String(db.config.adminCode); }
    function admin() { need(db.config.adminCode, 'Chưa đặt mã admin trong Google Sheet'); env.guard('admin'); if (!isAdmin()) { env.fail('admin'); throw new Error('Sai mã admin'); } env.ok('admin'); }
    function player() {
      var pl = find(db.players, p.playerId);
      need(pl && pl.active !== 'no', 'Không tìm thấy thành viên');
      env.guard('pin:' + pl.id);
      if (env.hash(pl.salt + String(p.pin)) !== pl.pinHash) { env.fail('pin:' + pl.id); throw new Error('Sai mã PIN'); }
      env.ok('pin:' + pl.id);
      return pl;
    }
    function matchOf(id) { var m = find(db.matches, id); need(m, 'Không thấy trận'); return m; }
    function cleanName(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
    function nameTaken(name, exceptId) {
      var n = name.toLowerCase();
      return db.players.some(function (x) { return x.id !== exceptId && x.active !== 'no' && x.name.toLowerCase() === n; });
    }
    function pinOk(pin) { return /^\d{4}$/.test(String(pin || '')); }

    switch (a) {
      case 'register': {
        var name = cleanName(p.name);
        need(name.length >= 2 && name.length <= 30, 'Tên từ 2 đến 30 ký tự');
        need(!nameTaken(name), 'Tên này có người dùng rồi');
        need(pinOk(p.pin), 'PIN phải đúng 4 số');
        var salt = env.uid();
        var pl = { id: env.uid(), name: name, number: String(p.number || '').replace(/\D/g, '').slice(0, 3), pinHash: env.hash(salt + p.pin), salt: salt, active: 'yes', createdAt: iso(now) };
        db.players.push(pl); ch.players = 1;
        // Tên trùng khớp lịch sử → tự cộng bàn thắng cũ
        var hk = 'n:' + name.toLowerCase(), linked = 0;
        db.goals.forEach(function (g) { if (g.scorer.toLowerCase() === hk) { g.scorer = pl.id; linked += num(g.count); } });
        if (linked) ch.goals = 1;
        db.wallet.forEach(function (w) { if (w.playerId.toLowerCase() === hk) { w.playerId = pl.id; ch.wallet = 1; } });
        res.player = { id: pl.id, name: pl.name, linked: linked };
        break;
      }
      case 'login': { var pl2 = player(); res.player = { id: pl2.id, name: pl2.name }; break; }
      case 'vote': {
        var me = player(), m = matchOf(p.matchId);
        need(m.status === 'open' && m.source !== 'history', 'Trận này đã chốt hoặc đã hủy');
        need(today(now) <= m.date, 'Trận đã qua rồi');
        need(p.vote === 'di' || p.vote === 'khong', 'Vote không hợp lệ');
        db.votes.push({ matchId: m.id, playerId: me.id, vote: p.vote, ts: iso(now) }); ch.votes = 1;
        break;
      }
      case 'adminLogin': admin(); break;
      case 'saveMatch': {
        admin();
        var mm = p.id ? matchOf(p.id) : null;
        if (!mm) {
          need(/^\d{4}-\d{2}-\d{2}$/.test(p.date || ''), 'Chọn ngày đá');
          mm = { id: env.uid(), date: p.date, time: '', opponent: '', place: '', status: 'open', gf: '', ga: '', fieldCost: '', snap: '', source: 'app' };
          db.matches.push(mm);
        }
        if (p.date && mm.snap !== 'yes') mm.date = p.date;
        mm.time = p.time != null ? String(p.time) : mm.time;
        mm.opponent = p.opponent != null ? cleanName(p.opponent) : mm.opponent;
        mm.place = p.place != null ? cleanName(p.place) : mm.place;
        ch.matches = 1; res.id = mm.id;
        break;
      }
      case 'cancelMatch': {
        admin(); var cm = matchOf(p.id);
        if (p.cancel) {
          need(cm.status !== 'done', 'Trận đã chốt kết quả, không hủy được');
          cm.status = 'cancelled';
          db.charges.forEach(function (c) { if (c.matchId === cm.id && c.status === 'unpaid') { c.status = 'void'; c.note = 'hủy trận'; } });
        } else {
          cm.status = 'open';
          db.charges.forEach(function (c) { if (c.matchId === cm.id && c.status === 'void' && c.note === 'hủy trận') { c.status = 'unpaid'; c.note = ''; } });
        }
        ch.matches = 1; ch.charges = 1;
        break;
      }
      case 'deleteMatch': {
        admin(); var dm = matchOf(p.id);
        need(!db.charges.some(function (c) { return c.matchId === dm.id && c.status === 'paid'; }), 'Trận có khoản đã thu tiền, không xóa được. Hãy hủy trận thay vì xóa.');
        function keep(x) { return x.matchId !== dm.id; }
        db.matches = db.matches.filter(function (x) { return x.id !== dm.id; });
        db.charges = db.charges.filter(keep); db.goals = db.goals.filter(keep); db.attend = db.attend.filter(keep);
        db.votes = db.votes.filter(keep); db.snaps = db.snaps.filter(keep); db.txns = db.txns.filter(keep);
        ch.matches = ch.charges = ch.goals = ch.attend = ch.votes = ch.snaps = ch.txns = 1;
        break;
      }
      case 'finalize': {
        admin(); var fm = matchOf(p.id);
        need(fm.status !== 'cancelled', 'Trận đã hủy');
        var hist = fm.source === 'history';
        need(hist || now >= deadline(fm.date), 'Chưa qua hạn vote (20h tối thứ 7)');
        if (!hist && fm.snap !== 'yes') ensure(db, now, env);
        fm.gf = String(num(p.gf)); fm.ga = String(num(p.ga)); fm.status = 'done';
        fm.fieldCost = String(num(p.fieldCost));
        // Ghi bàn
        var oldHidden = {};
        db.goals.forEach(function (g) { if (g.matchId === fm.id && g.hidden === 'yes') oldHidden[g.scorer] = 1; });
        db.goals = db.goals.filter(function (g) { return g.matchId !== fm.id; });
        (p.scorers || []).forEach(function (s) {
          var c = Math.floor(num(s.count));
          if (c > 0 && s.key) db.goals.push({ matchId: fm.id, scorer: String(s.key), count: String(c), hidden: oldHidden[s.key] ? 'yes' : '' });
        });
        ch.goals = 1; ch.matches = 1;
        if (!hist) {
          var absent = p.absent || [], extra = p.extra || [];
          db.attend = db.attend.filter(function (x) { return x.matchId !== fm.id; });
          absent.forEach(function (pid) { db.attend.push({ matchId: fm.id, playerId: pid, status: 'absent' }); });
          extra.forEach(function (pid) { db.attend.push({ matchId: fm.id, playerId: pid, status: 'extra' }); });
          ch.attend = 1;
          var finesOn = fm.date >= cfg(db, 'fineStart');
          var want = [];
          db.snaps.forEach(function (s) {
            if (s.matchId !== fm.id || s.vote !== 'di') return;
            if (absent.indexOf(s.playerId) >= 0) { if (finesOn && !resting(find(db.players, s.playerId), fm.date)) want.push({ pid: s.playerId, type: 'absent', amt: cfg(db, 'absentFine') }); }
            else want.push({ pid: s.playerId, type: 'fee', amt: cfg(db, 'feeAmount') });
          });
          extra.forEach(function (pid) {
            if (!want.some(function (w) { return w.pid === pid && w.type === 'fee'; })) want.push({ pid: pid, type: 'fee', amt: cfg(db, 'feeAmount') });
          });
          var used = {};
          db.charges = db.charges.filter(function (c) {
            if (c.matchId !== fm.id || (c.type !== 'fee' && c.type !== 'absent')) return true;
            for (var i = 0; i < want.length; i++) if (!used[i] && want[i].pid === c.playerId && want[i].type === c.type) { used[i] = 1; return true; }
            return c.status === 'paid' && c.note !== 'ví'; // khoản đã thu tiền mặt thì giữ lại; trả bằng ví thì hoàn ví
          });
          want.forEach(function (w, i) { if (!used[i]) db.charges.push(newCharge(env, w.pid, fm.id, w.type, w.amt, 'duc', fm.date)); });
          ch.charges = 1;
        }
        // Tiền sân
        db.txns = db.txns.filter(function (x) { return !(x.cat === 'field' && x.matchId === fm.id); });
        if (num(p.fieldCost) > 0) {
          db.txns.push({ id: env.uid(), date: fm.date, kind: 'out', cat: 'field', amount: String(num(p.fieldCost)),
            holder: p.fieldPayer === 'tan' ? 'tan' : 'duc', to: '', note: 'Tiền sân' + (fm.opponent ? ' – ' + fm.opponent : ''), matchId: fm.id });
        }
        ch.txns = 1;
        break;
      }
      case 'setPaid': {
        admin();
        (p.ids || []).forEach(function (id) {
          var c = find(db.charges, id); if (!c || c.status === 'void') return;
          c.status = p.paid ? 'paid' : 'unpaid'; c.paidAt = p.paid ? iso(now) : ''; if (c.note === 'ví') c.note = '';
        });
        ch.charges = 1; break;
      }
      case 'setExempt': {
        admin(); var ec = find(db.charges, p.id); need(ec, 'Không thấy khoản này');
        need(ec.status !== 'paid', 'Khoản này đã thu tiền rồi');
        ec.status = p.exempt ? 'void' : 'unpaid'; ec.note = p.exempt ? 'miễn' : '';
        ch.charges = 1; break;
      }
      case 'addTxn': {
        admin();
        var amt = Math.round(num(p.amount));
        need(amt > 0, 'Nhập số tiền');
        need(['in', 'out', 'transfer'].indexOf(p.kind) >= 0, 'Loại không hợp lệ');
        var holder = p.holder === 'duc' ? 'duc' : 'tan';
        db.txns.push({ id: env.uid(), date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : today(now), kind: p.kind,
          cat: String(p.cat || 'other'), amount: String(amt), holder: holder, to: p.kind === 'transfer' ? (holder === 'duc' ? 'tan' : 'duc') : '',
          note: cleanName(p.note), matchId: '' });
        ch.txns = 1; break;
      }
      case 'delTxn': { admin(); db.txns = db.txns.filter(function (x) { return x.id !== p.id; }); ch.txns = 1; break; }
      case 'setPlayer': {
        admin(); var sp = find(db.players, p.id); need(sp, 'Không thấy thành viên');
        if (p.name != null) { var nn = cleanName(p.name); need(nn.length >= 2, 'Tên quá ngắn'); need(!nameTaken(nn, sp.id), 'Tên này có người dùng rồi'); sp.name = nn; }
        if (p.number != null) sp.number = String(p.number).replace(/\D/g, '').slice(0, 3);
        if (p.active != null) sp.active = p.active ? 'yes' : 'no';
        if (p.rest != null) {
          var rv = String(p.rest);
          need(rv === '' || /^\d{4}-\d{2}-\d{2}$/.test(rv), 'Ngày nghỉ không hợp lệ');
          sp.rest = rv;
          // bỏ phạt không vote của các trận đã chốt vote trong thời gian nghỉ (chưa trả)
          if (rv) db.charges.forEach(function (c) { if (c.playerId === sp.id && c.type === 'novote' && c.status === 'unpaid' && c.date <= rv && c.date >= addDays(today(now), -7)) { c.status = 'void'; c.note = 'tạm nghỉ'; ch.charges = 1; } });
        }
        if (p.pin) { need(pinOk(p.pin), 'PIN phải đúng 4 số'); sp.salt = env.uid(); sp.pinHash = env.hash(sp.salt + p.pin); }
        ch.players = 1; break;
      }
      case 'mergeName': {
        admin(); var mp = find(db.players, p.playerId); need(mp, 'Chọn thành viên');
        var key = 'n:' + p.name, n2 = 0;
        db.goals.forEach(function (g) { if (g.scorer === key) { g.scorer = mp.id; n2++; } });
        db.wallet.forEach(function (w) { if (w.playerId === key) { w.playerId = mp.id; n2++; } });
        need(n2 > 0, 'Không thấy tên này trong lịch sử');
        ch.goals = 1; ch.wallet = 1; res.count = n2; break;
      }
      case 'topup': {
        admin(); var tp = find(db.players, p.playerId); need(tp, 'Chọn thành viên');
        var ta = Math.round(num(p.amount)); need(ta > 0, 'Nhập số tiền');
        db.wallet.push({ id: env.uid(), playerId: tp.id, date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : today(now), kind: 'topup', amount: String(ta), chargeId: '', note: cleanName(p.note) });
        ch.wallet = 1; break;
      }
      case 'delTopup': {
        admin(); var before = db.wallet.length;
        db.wallet = db.wallet.filter(function (w) { return !(w.id === p.id && w.kind === 'topup'); });
        need(db.wallet.length < before, 'Không thấy lần nạp này');
        ch.wallet = 1; break;
      }
      case 'claim': {
        var cme = player(), col = p.collector === 'tan' ? 'tan' : 'duc';
        var pend = {};
        db.claims.forEach(function (x) { if (x.status === 'pending') parseItems(x.items).forEach(function (it) { pend[it.id] = 1; }); });
        var items = [], total = 0;
        (p.chargeIds || []).forEach(function (id) {
          var c = find(db.charges, id);
          need(c && c.playerId === cme.id && c.collector === col && c.status === 'unpaid', 'Khoản này không còn nợ nữa, tải lại app nhé');
          need(!pend[id], 'Có khoản đã gửi yêu cầu rồi, đang chờ admin xác nhận');
          var amt = num(c.amount) - walletUsed(db, c.id);
          if (amt > 0) { items.push(id + ':' + amt); total += amt; }
        });
        // Tiền sân trận chưa chốt (chuyển trước giờ đá)
        if (col === 'duc') (p.matchIds || []).forEach(function (mid) {
          var mm2 = find(db.matches, mid);
          need(mm2 && mm2.source === 'app' && mm2.status === 'open', 'Trận này không nhận tiền sân trước được');
          need(!pend['M_' + mid], 'Tiền sân trận này đã gửi xác nhận rồi');
          need(!db.charges.some(function (c) { return c.playerId === cme.id && c.matchId === mid && c.type === 'fee' && c.status === 'paid'; }), 'Tiền sân trận này đã trả rồi');
          var fa = num(cfg(db, 'feeAmount')); items.push('M_' + mid + ':' + fa); total += fa;
        });
        var top = col === 'duc' ? Math.round(num(p.topup)) : 0;
        need(items.length || top > 0, 'Chọn khoản đã chuyển hoặc nhập số tiền nạp ví');
        db.claims.push({ id: env.uid(), playerId: cme.id, collector: col, items: items.join(';'), topup: String(top), amount: String(total + top),
          status: 'pending', createdAt: iso(now), decidedAt: '', note: cleanName(p.note) });
        ch.claims = 1; break;
      }
      case 'cancelClaim': {
        var cp = player(), cc = find(db.claims, p.id);
        need(cc && cc.playerId === cp.id && cc.status === 'pending', 'Không hủy được yêu cầu này');
        db.claims = db.claims.filter(function (x) { return x.id !== cc.id; }); ch.claims = 1; break;
      }
      case 'approveClaim': {
        admin(); var ac = find(db.claims, p.id); need(ac && ac.status === 'pending', 'Yêu cầu không còn chờ xác nhận');
        var extra = 0;
        parseItems(ac.items).forEach(function (it) {
          if (it.id.indexOf('M_') === 0) { // tiền sân trả trước khi chốt trận
            var mid = it.id.slice(2), fc = null;
            db.charges.forEach(function (c) { if (c.playerId === ac.playerId && c.matchId === mid && c.type === 'fee' && c.status === 'unpaid') fc = c; });
            if (fc) { fc.status = 'paid'; fc.paidAt = iso(now); fc.note = 'ck'; }
            else { var mmx = find(db.matches, mid); db.wallet.push({ id: env.uid(), playerId: ac.playerId, date: today(now), kind: 'topup', amount: String(it.amt), chargeId: '', note: 'tiền sân ' + (mmx ? mmx.date.slice(8) + '/' + mmx.date.slice(5, 7) : '') }); }
            return;
          }
          var c = find(db.charges, it.id);
          if (c && c.status === 'unpaid') { c.status = 'paid'; c.paidAt = iso(now); c.note = 'ck'; }
          else extra += it.amt; // khoản đã được trả cách khác → tiền thừa
        });
        var add = num(ac.topup) + extra;
        if (add > 0) {
          if (ac.collector === 'duc') db.wallet.push({ id: env.uid(), playerId: ac.playerId, date: today(now), kind: 'topup', amount: String(add), chargeId: '', note: 'chuyển khoản' });
          else db.txns.push({ id: env.uid(), date: today(now), kind: 'in', cat: 'other', amount: String(add), holder: 'tan', to: '', note: 'Tiền thừa CK', matchId: '' });
        }
        ac.status = 'ok'; ac.decidedAt = iso(now);
        ch.claims = ch.charges = ch.wallet = ch.txns = 1; break;
      }
      case 'rejectClaim': {
        admin(); var rc = find(db.claims, p.id); need(rc && rc.status === 'pending', 'Yêu cầu không còn chờ xác nhận');
        rc.status = 'rejected'; rc.decidedAt = iso(now); rc.note = cleanName(p.note || rc.note); ch.claims = 1; break;
      }
      case 'setConfig': {
        admin();
        Object.keys(p.values || {}).forEach(function (k) { if (PUBLIC_KEYS.indexOf(k) >= 0) db.config[k] = String(p.values[k]).trim(); });
        ch.config = 1; break;
      }
      default: throw new Error('Lệnh không hợp lệ');
    }
    var wc = applyWallet(db, now, env); Object.keys(wc).forEach(function (k) { ch[k] = 1; });
    return { res: res, ch: ch };
  }

  function parseItems(s) {
    return String(s || '').split(';').filter(Boolean).map(function (x) { var a = x.split(':'); return { id: a[0], amt: num(a[1]) }; });
  }

  /* ---------- tồn quỹ ---------- */
  function summary(db) {
    var b = { tan: 0, duc: 0, held: 0 };
    db.charges.forEach(function (c) {
      if (c.status === 'paid') b[c.collector] += num(c.amount);
      else if (c.status === 'unpaid') b[c.collector] += walletUsed(db, c.id);
    });
    db.txns.forEach(function (t) {
      var a = num(t.amount);
      if (t.kind === 'in') b[t.holder] += a; else if (t.kind === 'out') b[t.holder] -= a; else { b[t.holder] -= a; b[t.to] += a; }
    });
    db.wallet.forEach(function (w) { b.held += w.kind === 'use' ? -num(w.amount) : num(w.amount); });
    return b;
  }

  /* ---------- dữ liệu gửi về app ----------
     full = true (đúng mã admin): gửi hết.
     Người thường: KHÔNG gửi thu chi và quỹ quý đã đóng/miễn (chỉ còn khoản quỹ quý đang nợ). */
  function view(db, full) {
    var c = {};
    PUBLIC_KEYS.forEach(function (k) { c[k] = cfg(db, k); });
    return {
      full: !!full, config: c, adminSet: !!db.config.adminCode, sum: summary(db),
      players: db.players.map(function (p) { return { id: p.id, name: p.name, number: p.number, active: p.active, createdAt: p.createdAt, rest: p.rest || '' }; }),
      matches: db.matches, votes: db.votes, snaps: db.snaps,
      charges: full ? db.charges : db.charges.filter(function (x) { return x.type !== 'dues' || x.status === 'unpaid'; }),
      goals: db.goals, txns: full ? db.txns : db.txns.filter(function (t) { return t.cat === 'field'; }).map(function (t) { return { id: t.id, cat: t.cat, matchId: t.matchId, amount: t.amount, holder: t.holder, date: t.date, kind: t.kind }; }),
      attend: db.attend, wallet: db.wallet, claims: db.claims
    };
  }
  function isAdminCode(db, code) { return !!db.config.adminCode && String(code || '') === String(db.config.adminCode); }

  /* ---------- nạp lịch sử từ FC_SEED ---------- */
  function seed(db, S) {
    if (db.matches.some(function (m) { return m.source === 'history'; })) return {};
    S.matches.forEach(function (m) {
      db.matches.push({ id: m[0], date: m[1], time: '18:00', opponent: m[2], place: '', status: 'done', gf: String(m[3]), ga: String(m[4]), fieldCost: '', snap: '', source: 'history' });
    });
    S.goals.forEach(function (g) { db.goals.push({ matchId: g[0], scorer: 'n:' + g[1], count: String(g[2]), hidden: g[3] ? 'yes' : '' }); });
    var ch = { matches: 1, goals: 1 };
    if (S.opening && !db.txns.some(function (t) { return t.cat === 'opening'; })) {
      db.txns.push({ id: 'open1', date: S.opening.date, kind: 'in', cat: 'opening', amount: String(S.opening.amount), holder: S.opening.holder, to: '', note: 'Tồn quỹ khi bắt đầu dùng app', matchId: '' });
      ch.txns = 1;
    }
    (S.prepaid || []).forEach(function (w, i) {
      db.wallet.push({ id: 'pre' + i, playerId: 'n:' + w[0], date: S.opening ? S.opening.date : '', kind: 'topup', amount: String(w[1]), chargeId: '', note: 'đóng trước từ trước' });
      ch.wallet = 1;
    });
    return ch;
  }

  return { resting: resting, parseItems: parseItems, TABLES: TABLES, DEF: DEF, summary: summary, isAdminCode: isAdminCode, ensure: ensure, handle: handle, view: view, seed: seed,
    walletUsed: walletUsed, deadline: deadline, today: today, addDays: addDays, weekday: weekday, quarterOf: quarterOf, lastVote: lastVote, num: num };
})();
if (typeof module !== 'undefined') module.exports = FC;
