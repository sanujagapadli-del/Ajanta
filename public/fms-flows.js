// FMS Workflows page (client 2026-11-05: "jitne bhi fms hai uska work flow design krke yha lgao
// taki in future mujhe dekhna hai to mai dekh saku ki kya condition lgai hui hai … simple rkhna").
// Plain-language map of every FMS: how it starts, each step (doer, due time, what to fill)
// and the conditions written into the server code. Static text — when a rule changes in
// server.js, change it here too. Rendered by renderFmsFlows() in app.html.
//   step: { no, name, doer, due, fill, only (when this step applies), cond: [ 'If … → …' ], end (bool) }
window.FMS_FLOWS = [
// ─────────────────────────────────────────────────────────────── O2D
{
  key: 'o2d', icon: '🚚', title: 'O2D FMS (Order to Dispatch)', page: 'o2d-fms',
  summary: 'Dealer ka order → accounts OK → stock check → bill → maal nikalna → loading. Har product line alag chalti hai.',
  start: {
    who: 'Koi bhi logged-in user ("+ New Order"), jab tak form block na ho',
    fill: ['Dealer — list se hi chunna (Tally debtors + Dealer Master); type karne se sirf search hota hai', 'Kam se kam 1 product, qty > 0 (rate optional, minus nahi)', 'CD / Discount % 0 se 50 ke beech'],
    notes: ['Naya dealer ho to pehle Dealer Master me daalo', 'Rate ₹20 se kam aur qty 100 se zyada → "Qty aur Rate ulte to nahi bhare?"', 'Usi dealer ka 30 min ke andar order → "Phir bhi naya order banana hai?"', 'Ord-NNNN number; Old / New Counter khud lagta hai', 'Team WhatsApp group me "नया ऑर्डर प्राप्त हुआ" (items, total, CD, net)'],
  },
  steps: [
    { no: 1, name: 'Accounts is ok or not', doer: 'Accountant', due: '10 min', fill: 'Yes / No (+ reason)', cond: ['No → poora order CANCEL'] },
    { no: 2, name: 'Good Check', doer: 'Niranjan (Warehouse)', due: '10 min', fill: 'Har item: Available / Not Available (+ available qty)',
      cond: ['Not Available → sirf wo item hatta hai; saare Not Available → order cancel', 'Stock kam hai → line available qty tak, baaki naya order "Ord-XXXX-P1" Step 1 se ("Pending stock")'] },
    { no: 3, name: 'Call Made By CRM (Add More Order)', doer: 'Kavita', due: '10 min', fill: 'Done, ya "+ Add Order" se aur items', cond: ['Naye items Step 1 se chalte hain — tab tak poora order rukta hai'] },
    { no: 4, name: 'Make Bill', doer: 'Accountant', due: '10 min', fill: 'Bill No, Amount, Invoice (zaroori), Bill Date',
      cond: ['Bill se pehle item ka naam / rate / qty badal sakte hain (qty 0 = item hata)', 'Dealer ko WhatsApp: bill PDF + Google review link (phone ho to)'] },
    { no: 5, name: 'Goods Takeout and Photo', doer: 'Niranjan', due: '30 min', fill: 'Doer naam + Photo (zaroori), video optional', cond: ['Yahin stock me se OUT hota hai'] },
    { no: 6, name: 'Check physical stock with bill', doer: 'Aziz', due: '10 min', fill: 'Doer naam' },
    { no: 7, name: 'Arrange Loader', doer: 'Kavita', due: '10 min', fill: 'Sirf Done' },
    { no: 8, name: 'In / Out Entry', doer: 'Priyanka (SCCRR)', due: '10 min', fill: 'Sirf Done' },
    { no: 9, name: 'Load Goods', doer: 'Niranjan', due: '30 min', fill: 'Loader naam + Delivery By (optional)', end: true },
  ],
  rules: [
    'Step tabhi khulta hai jab pichhle saare steps done hon aur koi "No" na ho',
    'Doer admin "Step Doers" me chunta hai; kisi step ka doer na ho to sab kar sakte hain',
    'Planned time Google Sheet formula se — 10 / 30 min sirf label',
    'Hold: admin / HOD / PC / step doer — "Stock not available" ya "Other" (reason). Hold me koi step nahi hota',
    'Cancel: wahi log, reason zaroori; dispatch ke baad nahi',
    'Restart: sirf admin / PC — sab steps saaf, Step 1 se dobara',
    'Item hatana sirf Make Bill se pehle (kam se kam 1 item rahe)',
    'Delivered date alag se (future nahi; undo sirf admin)',
    'Band: har line ka Step 9 done, ya cancel',
  ],
},
// ─────────────────────────────────────────────────────────────── SERVICE
{
  key: 'service', icon: '🛠️', title: 'Service FMS (Complaint)', page: 'service-fms',
  summary: 'Customer complaint → warranty → spare → mechanic assign → spare nikalna → OTP se solve → spare wapas. Har product alag line (C-N-1, C-N-2).',
  start: {
    who: 'Sirf Service step doer, PC View wale, mechanic ya admin',
    fill: ['Customer naam + mobile', 'Ownership: Dealer Stock Piece / Customer Purchased Piece', 'Kam se kam 1 product + problem'],
    notes: ['Bill photo abhi optional; "Bill nahi hai" = out of warranty, customer paise dega', 'Out of warranty → "customer service charge dega" tick ke bina save nahi', 'Warranty Product Master ke months se; Cooler Water Pump / Swing Motor = kharid wale saal ke 31 Dec tak', 'Usi mobile ka 30 min me complaint → confirm puchta hai', 'Urgent tick = sabse upar', 'Customer ko "complaint registered" WhatsApp'],
  },
  steps: [
    { no: 1, name: 'Check Product in Warranty', doer: 'Service Mail', due: 'Complaint + TAT (office time ke baad → agle din subah)', fill: 'Yes / No', cond: ['Warranty nikal sake ya "No Bill" ho to khud done ho jaata hai', 'Yes ya No — dono me aage chalta hai'] },
    { no: 2, name: 'Spare Available?', doer: 'Niranjan', due: 'Step 1 + TAT', fill: 'Available / Need to be Purchased',
      cond: ['Need to be Purchased → complaint HOLD, jab tak "Available" na ho', 'Customer Purchased Piece me bill photo ke bina aage nahi (jab tak "No Bill" na chuna ho)'] },
    { no: 3, name: 'Assign to Mechanic', doer: 'Ajiz Ji', due: 'Usi din 6 PM', fill: 'Mechanic (zaroori); Zone area se khud', cond: ['Step 2 "Available" ke bina nahi hota'] },
    { no: 4, name: 'Takeout Spare', doer: 'Niranjan', due: 'Usi din 5 PM', fill: 'Kam se kam 1 spare, qty 1+ (spare master list se; naya spare sirf admin)', cond: ['Bill wala rule yahan bhi check hota hai'] },
    { no: 5, name: "Mechanic's Complaint Solve", doer: 'Wahi mechanic jo assign hua', due: 'Usi din 6 PM', fill: '"Kya kiya", kitne spare lagaye, Repair Status: Repaired at Location / Brought to Office',
      cond: ['Customer ko 6 digit OTP WhatsApp par — mechanic OTP daale tabhi done', 'Admin bina OTP kar sakta hai ("Bina OTP — admin" likha jaata hai)', 'OTP ke saath Google review link'] },
    { no: 6, name: 'Check In/Out (Spare Return)', doer: 'Niranjan (store)', due: 'Solve + sheet ke working days', fill: 'Har spare: naye wapas + purane wapas (short = liya − naye − purane)', end: true,
      cond: ['Kuch short nahi → done, complaint BAND', 'Short ka cash → "Pending Approval" (cash approver, default Ajay) → Approve = band, Reject = dobara bharo', 'Short, cash nahi → step pending jab tak piece wapas na aaye'] },
  ],
  rules: [
    'Planned time sheet formula se: office time sheet ke C1/D1, TAT row 5; Sunday chhutti; Step 4-6 Holidays list bhi chhodte hain',
    'Doer = "Step Doers". Kisi step ka doer na ho to sirf admin / PC View kar sakte hain',
    'Send back to Assign: Assign doer, reason zaroori (Assign ke baad, Solve se pehle)',
    'Mechanic transfer: Assign doer, Solve se pehle',
    'Naya spare baad me jodna: Takeout / Assign doer ya wahi mechanic, Solve se pehle',
    'Send to Replacement: Assign / Takeout doer → Replacement FMS me entry, complaint khatam',
    'Delete sirf admin (reason, restore ho sakta hai). Restart / Cancel nahi hai',
    'Mechanic ko pending list WhatsApp — manual button',
  ],
},
// ─────────────────────────────────────────────────────────────── REPLACEMENT
{
  key: 'replacement', icon: '🔁', title: 'Replacement FMS', page: 'replacement-fms',
  summary: 'Customer / dealer ka kharab maal aata hai → repair, exchange, credit note ya wapas. Category ke hisaab se raasta badalta hai.',
  start: {
    who: 'Replacement page wala koi bhi (ya Service FMS se "Send to Replacement" — Assign / Takeout doer)',
    fill: ['Party name', 'Item + quantity', 'Defect', 'Kam se kam 1 product photo (max 6)'],
    notes: ['Customer mobile khali ho to Dealer Master se dealer ka phone le leta hai', 'Code = R-number (purani sheet ki series aage)', 'Service FMS se bheja to service complaint band ho jaati hai'],
  },
  steps: [
    { no: 1, name: 'Diary Entry', doer: 'Priyanka', due: 'Form ke 4 ghante baad', fill: 'Diary No. + "sticker lagaya" tick', cond: ['Customer mobile ho to "maal mil gaya" WhatsApp (English + Hindi)'] },
    { no: 2, name: 'Ownership Check', doer: 'Priyanka', due: '4 ghante', fill: 'Hamara product? Yes / No', cond: ['No → reason zaroori → seedha Assign Delivery (15) → Handover (16) → band "Returned"'] },
    { no: 3, name: 'Decide Category', doer: 'Priyanka', due: '4 ghante', fill: 'Repair / Exchange / Credit Note (Maal Wapas) / Out of Warranty', cond: ['Category se aage ka raasta tay hota hai (neeche "Raaste" dekhein)'] },
    { no: 4, name: 'Warranty & Charges', doer: 'Priyanka / Aziz', due: '8 ghante', only: 'Sirf Repair aur Out of Warranty', fill: 'In / Out of Warranty. Out me: reason, charges ₹, rate kisko bataya (Customer/Dealer), customer maana Yes/No',
      cond: ['Category Out of Warranty hai to yahan bhi Out of Warranty hi chunna padega', 'Customer ne mana kiya (No) → repair nahi → Assign Delivery (15) → Handover (16) → paisa liya ho to Cash from Staff (17)'] },
    { no: 5, name: 'Give to Mechanic', doer: 'Priyanka', due: '4 ghante', fill: 'Mechanic + kitne din lagenge (0 se zyada)' },
    { no: 6, name: 'Spare Issue', doer: 'Niranjan', due: '4 ghante', fill: 'Spare item + qty, ya "koi spare nahi diya" tick' },
    { no: 7, name: 'Repair & Test', doer: 'Wahi mechanic jisko diya', due: 'Mechanic ke din × 24 ghante', fill: '"Tested OK" tick' },
    { no: 8, name: 'Spare Takeout', doer: 'Mechanic', due: '4 ghante', only: 'Sirf jab spare diya gaya ho', fill: 'Har spare: used + returned = jitna diya tha' },
    { no: 9, name: 'Spare Check', doer: 'Niranjan', due: '4 ghante', fill: 'OK / Short (Short me remark zaroori)', cond: ['Spare steps aane se pehle repair hue purane record me 6, 8, 9 skip'] },
    { no: 10, name: 'Instant Exchange', doer: 'Aziz', due: 'Category ke 6 ghante baad', only: 'Sirf Exchange', fill: 'Stock se naya item + purana piece kahan gaya: Reject Bin YA Stock (ek hi)' },
    { no: 11, name: 'Inform Dealer / Salesman', doer: 'Priyanka', due: '4 ghante', only: 'Repair, Out of Warranty (maana), Exchange', fill: 'Remark — kisko, kaise bataya', cond: ['Chahein to customer ko "ready" WhatsApp + salesman ko WhatsApp'] },
    { no: 12, name: 'Check Returned Goods', doer: 'Aziz', due: 'Category ke 4 ghante baad', only: 'Sirf Credit Note', fill: 'OK (stock me) / Damaged (reject bin)' },
    { no: 13, name: 'Make Credit Note', doer: 'Accountant', due: '24 ghante', only: 'Sirf Credit Note', fill: 'Credit Note No. + photo/PDF (amount optional)' },
    { no: 14, name: 'Share Credit Note', doer: 'Accountant', due: '24 ghante', only: 'Sirf Credit Note', fill: 'WhatsApp screenshot', end: true, cond: ['Yahin band — Credit Note me handover nahi hota'] },
    { no: 15, name: 'Assign Delivery Person', doer: 'Priyanka', due: '4 ghante', fill: 'Delivery wala user', cond: ['Us bande ko WhatsApp: customer se OTP lena hai'] },
    { no: 16, name: 'Handover (OTP)', doer: 'Sirf wahi delivery person (ya admin)', due: '48 ghante', fill: 'Customer ka OTP (6 digit, 30 min valid). Optional: receiver, charges liye ₹, remark',
      cond: ['Galat / purana OTP = mana', 'Admin bina OTP band kar sakta hai, par receiver ka naam dena hoga', 'Customer ko "delivered" WhatsApp'] },
    { no: 17, name: 'Cash from Staff', doer: 'Accountant', due: 'Handover ke 24 ghante baad', only: 'Sirf jab handover par charges > 0 liye', fill: 'Staff ka naam + amount', end: true },
  ],
  paths: [
    ['Repair / Out of Warranty (maana)', '1 → 2 → 3 → 4 → 5 → 6 → 7 → (8) → 9 → 11 → 15 → 16 → (17)'],
    ['Out of Warranty (mana kiya)', '1 → 2 → 3 → 4 → 15 → 16 → (17)'],
    ['Exchange', '1 → 2 → 3 → 10 → 11 → 15 → 16 → (17)'],
    ['Credit Note (Maal Wapas)', '1 → 2 → 3 → 12 → 13 → 14 → band'],
    ['Hamara product nahi', '1 → 2 → 15 → 16 → band "Returned"'],
  ],
  rules: [
    'Har step ka doer admin "Step Doers" me chunta hai (upar likhe naam default hain). Kisi step ka doer na ho to sirf admin kar sakta hai',
    'Time ghanton me ginta hai — din-raat, Sunday ka koi alag rule nahi',
    'Steps order me hi hote hain — jo current step nahi hai wo nahi hoga',
    'Cancel: admin ya Diary / Check doer, reason zaroori. Dobara kholne (reopen) ka option nahi',
    'Kaun dekhe: admin + step doers sab; baaki sirf apne daale hue, ya jisme wo mechanic / delivery person hai',
  ],
},
// ─────────────────────────────────────────────────────────────── LEAD
{
  key: 'lead', icon: '🎯', title: 'Lead FMS', page: 'lead-fms',
  summary: 'Naya dealer / customer lead → call → salesman visit → order ya naya dealer (Onboarding).',
  start: {
    who: 'Lead page wala koi bhi',
    fill: ['Lead type: Incoming / Outgoing', 'Shop ya contact naam', 'Mobile ya visiting card photo'],
    notes: ['Usi mobile ki open lead pehle se ho to warning (phir bhi bana sakte hain)', 'Market Visit lead = Outgoing; source "Market Visit", salesman = jisne daali', 'Source: Instagram / Facebook / Market Visit / Reference / Walk-in / Other', 'Code = L-number'],
  },
  steps: [
    { no: 1, name: 'Call + Send Catalogue', doer: 'SC-NBD', due: 'Banne ke agle din (ya next-call date par)', fill: 'Call result; tick karo to latest catalogue PDF WhatsApp par',
      cond: ['Order Mil Gaya → band "Order" (₹ optional)', 'Requirement Nahi → band "No Requirement"', 'Salesman Bhejo / Sample Leke Bhejo → Step 2', 'Catalogue Manga / Baad Me Call Karo / Phone Nahi Utha → next-call date par phir Step 1 (default kal)'] },
    { no: 2, name: 'Fix Salesman Visit', doer: 'SC-NBD', due: 'Usi din', fill: 'Visit date + salesman', cond: ['Salesman ko WhatsApp jaata hai', 'Visit pending ho tab bhi dobara (reschedule) kar sakte hain'] },
    { no: 3, name: 'Salesman Visit', doer: 'Jo salesman assign hua (ya SC-NBD)', due: 'Visit date par', fill: 'Result; remark + photo optional',
      cond: ['Order Mil Gaya → band "Order"', 'Interested Nahi → band "Not Interested"', 'New Dealer Bana → band "Dealer Onboarded" + Onboarding form khulta hai', 'Dobara Visit → salesman ki di date par phir visit; date nahi to wapas Step 2'], end: true },
  ],
  rules: [
    'Step 1 aur 2 ka doer admin chunta hai (SC-NBD); Step 3 = assign hua salesman',
    'Time sirf date se — "1-2 din / same day" sirf label hai',
    'Cancel / Reopen: sirf SC-NBD ya admin, reason zaroori. Reopen = wapas Step 1, aaj due',
    'Edit: SC-NBD, admin ya jisne lead daali. Note koi bhi kaam karne wala daal sakta hai',
    'Status: Open (Call / Schedule / Visit) · Won (Order / Dealer Onboarded) · Lost (No Requirement / Not Interested) · Cancelled',
  ],
},
{
  key: 'onboarding', icon: '🤝', title: 'Dealer Onboarding', page: 'onboarding',
  summary: 'Naya dealer bana → documents + photos → Dealer Master me entry → welcome kit WhatsApp.',
  start: {
    who: 'Admin, Lead page ya Dealer page wale (Lead me "New Dealer Bana" par khud khulta hai)',
    fill: ['Shop, owner, mobile (kisi aur dealer ka number nahi hona chahiye)', 'GST photo (ya "GST nahi hai" tick)', 'Shop ke andar 4-6 photo + 1 bahar ki', 'Cheque photo'],
  },
  steps: [
    { no: 1, name: 'Dealer Master me entry', doer: 'Automatic', due: 'Save karte hi', fill: '—', cond: ['Dealer naya ho to banta hai, pehle se ho to update', 'Kisi open lead se juda ho to lead band "Dealer Onboarded"'] },
    { no: 2, name: 'Welcome Kit WhatsApp', doer: 'Automatic', due: 'Save karte hi', fill: '—', end: true,
      cond: ['Welcome text, service number, bank details, terms, warranty chart, payment QR, catalogues', 'Files + text admin set karta hai', 'Fail ho to "FAILED" dikhta hai — Resend button'] },
  ],
},
// ─────────────────────────────────────────────────────────────── PURCHASE / CHEQUE / VRL
{
  key: 'indent', icon: '📝', title: 'Purchase — Indent', page: 'purchase-fms',
  summary: 'Maal chahiye → indent → stock check → rate → (₹2 lakh+ par approval) → PO bana ke vendor ko. Har item alag line ki tarah chalta hai.',
  start: {
    who: 'Admin ya Purchase FMS page wala ("+ New Indent")',
    fill: ['Indent Type: Finished Goods / Spare Part / Office Stationery / Housekeeping', 'Raised By', '1 se 50 items — har item me Product, Qty (> 0), Vendor'],
    notes: ['Number = IND-000001…', 'Indent us step par dikhta hai jahan uski sabse peeche wali line hai'],
  },
  steps: [
    { no: 1, name: 'Check Stock', doer: 'Rajesh (Warehouse)', due: '1 ghanta', fill: 'Stock hai? Yes / No + kitna hai (khali = 0)', cond: ['"Yes" hone par bhi kuch skip NAHI hota — aage chalta hai'] },
    { no: 2, name: 'Finalise Rate', doer: 'Narender (Accounts)', due: '1 ghanta', fill: 'Fresh / Old Rate, Final rate (> 0), Lead time din (> 0)', cond: ['Usi product ka pichhla rate "Old Rate" me khud aa jaata hai', '"Old Rate" chuno to wahi Final rate ban jaata hai'] },
    { no: 3, name: 'Approval', doer: 'Ajay', due: '1 ghanta', only: 'Sirf jab value ₹2 lakh ya zyada (sheet decide karti hai)', fill: 'Approve (Yes) / Reject (No)',
      cond: ['₹2 lakh se kam → skip ("not needed — under ₹2 lakh")', 'Reject → line band "Rejected", aage nahi jaati'] },
    { no: 4, name: 'Generate PO & Send', doer: 'Priyanka', due: '1 ghanta', fill: 'Vendor + lines chuno, qty, rate, GST % (default 18)', end: true,
      cond: ['Delivery "Within 7 Days", payment "30 Days Credit" default', 'Vendor GST 08 se shuru / Rajasthan → CGST+SGST, warna IGST', 'PO-0001… number, PDF Drive par; PO number aate hi line done → PO Follow-up me', 'Vendor ko WhatsApp button se khud bhejna hai (automatic nahi)'] },
  ],
  rules: [
    'Har step ka doer admin "Step Doers" me chunta hai. Kisi step ka doer na ho to sab kar sakte hain',
    'Planned time Google Sheet ke formula se aata hai — "1 ghanta" sirf label',
    'Admin indent edit / delete tab tak kar sakta hai jab tak kisi line ka PO na bana ho',
    'Check Stock ke baad product naam nahi badalta',
    'Band: har line ka PO ban gaya ya reject hui',
  ],
},
{
  key: 'po', icon: '📦', title: 'Purchase — PO Follow-up', page: 'purchase-fms',
  summary: 'PO bana → vendor se follow-up → maal aaya (item-wise qty) → stock me automatic IN.',
  start: {
    who: 'Automatic — PO bante hi "Purchase Fms" sheet me har line ki row',
    fill: ['PO No, Indent, Vendor, Qty, Final Rate, Lead Time khud aa jaate hain'],
    notes: ['PO utna hi aage hai jitni uski sabse peeche wali line'],
  },
  steps: [
    { no: 1, name: 'Follow', doer: 'Priyanka', due: 'Har dusre din', fill: 'Remark + Next Followup date',
      cond: ['Maal aane tak har call log kar sakte hain (remark zaroori) — sab open lines par update', 'Vendor login se vendor khud bata sakta hai: In Production / Ready to Dispatch / Dispatched (qty ke saath)'] },
    { no: 2, name: 'Material Received', doer: 'Priyanka', due: 'Sheet formula (shayad PO date + lead time)', fill: 'Har item: is baar kitne aaye; receive date (aaj ya pehle); Vendor Bill No. optional', end: true,
      cond: ['Step 1 ke bina nahi hota', 'Thoda-thoda aaya to jud-ta jaata hai; Pending = order − aaya', 'Line band tab: aaya ≥ order, YA "Force Full Closed" = Yes (band karne ki wajah zaroori)', 'Order se zyada aaya → pehle confirm puchta hai', 'Stock me automatic IN — PO rate par, receive date se (force close 0 qty = kuch nahi)'] },
  ],
  rules: ['Planned date sheet formula se', 'Koi automatic WhatsApp / alert nahi', 'Band: PO ki saari lines closed'],
},
{
  key: 'cheque', icon: '🧾', title: 'Cheque FMS', page: 'cheque-fms',
  summary: 'Salesman cheque photo daalta hai → Accounts details + bank deposit → Pass ya Bounce. Bounce par penalty + CRM follow-up.',
  start: {
    who: 'Salesman (sirf cheque photo + note). Accounts bhi salesman ki taraf se daal sakta hai',
    fill: ['Cheque photo'],
    notes: ['Code = CHQ-n'],
  },
  steps: [
    { no: 1, name: 'Fill Cheque Details', doer: 'Accounts', due: '2 ghante', fill: 'Party, Cheque No, Cheque Date, Amount (> 0)', cond: ['Party mobile khali → dealer profile ka number', 'Deposit date khali → Cheque date hi', 'Party ka bounce-risk banner dikhta hai'] },
    { no: 2, name: 'Bank Deposit', doer: 'Accounts', due: 'Deposit date par', fill: '"Deposited" + date', cond: ['Ya Extend: nayi date + reason — cheque yahin rukta hai'] },
    { no: 3, name: 'Pass / Bounce', doer: 'Accounts', due: 'Deposit ke agle din 6 PM', fill: 'Pass, ya Bounce + reason (bank slip photo optional)',
      cond: ['Pass → band (Cleared)', 'Bounce → ek saath 3 cheezein khulti hain: salesman alert, Step 4, Step 5', 'Bounce WhatsApp: salesman + Step 4/5 doers ko; party ko Hindi me (tick default on)'] },
    { no: 4, name: 'Bounce: Ledger & Penalty', doer: 'Accounts', due: 'Bounce ke 1 din baad', only: 'Sirf Bounce', fill: '"Tally ledger entry done" tick; Penalty ₹ optional (khali = nahi lagi)', cond: ['Re-deposit ke baad bhi ye open rehta hai'] },
    { no: 5, name: 'Bounce: CRM Follow-up', doer: 'CRM', due: 'Har 2 din', only: 'Sirf Bounce', fill: 'Party ne kya kaha (zaroori)', end: true,
      cond: ['Next Followup → di date ya +2 din', 'Payment Received / New Cheque / Written Off → bounce band', 'Re-deposit → date ke saath wapas Step 2 (bounce history me rehta hai)', 'Dobara bounce → penalty, follow-up, alert phir khulte hain', 'Chahein to party ko reminder WhatsApp'] },
  ],
  rules: [
    'Salesman alert "party ko batao" — sirf salesman ya admin acknowledge kare (turant)',
    'Party risk: 365 din me 3+ bounce = HIGH ("sirf Advance Cash / Online") · 1-2 = watch. Sirf warning banner (Cheque + O2D New Order par), order rukta nahi',
    'Kisi step ka doer na ho to sirf admin kar sakta hai',
    'Cancel: Step 1 doer, reason zaroori',
    'Band: Cleared / Payment Received / New Cheque / Written Off (penalty bhi done) / Cancelled',
  ],
},
{
  key: 'vrl', icon: '↩️', title: 'Vendor Replacement Ledger', page: 'vendor-ledger',
  summary: 'Kharab maal vendor ko bheja (challan) → follow-up → naya maal / purana wapas / credit note → vendor statement.',
  start: {
    who: 'Vendor Replacement Ledger page wala ("New Replacement Challan")',
    fill: ['Vendor', 'Spare parts / Finished goods', 'Kam se kam 1 item (naam + qty > 0)', 'Kharab maal ki photo ya video'],
    notes: ['Optional: date, bill/challan no, reason, rate, GST, serial, follow-up person', 'Code = VRC-0001…'],
  },
  steps: [
    { no: 1, name: 'Follow-up with Vendor', doer: 'Follow-up person', due: 'Koi fixed time nahi', fill: 'Remark (zaroori), next date optional', cond: ['Baar-baar kar sakte hain; pehla follow-up = done'] },
    { no: 2, name: 'Material / Credit Note Received', doer: 'Ajanta staff', due: '—', fill: 'Har line: Naya maal / Purana wapas (remark) / Credit note (CN no.) — poora ya thoda',
      cond: ['Pending = bheja − settle hua; 0 hone par challan "Closed"', 'Pending se zyada → confirm + remark', 'Server Step 1 se pehle bhi allow karta hai (order sirf screen par)'] },
    { no: 3, name: 'Vendor Statement Received', doer: 'Ajanta staff', due: '—', only: 'Challan Closed hone ke baad', fill: 'Note + photo/PDF optional', end: true, cond: ['Undo sirf admin'] },
  ],
  rules: [
    '30 din se purana open challan laal dikhta hai',
    'Vendor login se vendor update de sakta hai: Repair me hai / Naya maal bheja / Repair karke bheja / Credit note diya — asli receipt Ajanta hi daalta hai',
    'Koi WhatsApp nahi, stock me automatic IN nahi',
    'Cancel sirf admin, reason zaroori',
  ],
},
];
