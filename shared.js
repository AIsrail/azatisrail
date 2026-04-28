/* azatisrail.cc — shared JS */

/* ═══════════════════════════════
   TRANSLATIONS
═══════════════════════════════ */
const T = {
ru:{
  nav_aud:'Для кого',nav_svc:'Услуги',nav_ev:'Мероприятия',nav_pub:'Публикации',nav_con:'Связаться',
  eyebrow:'Бишкек · Кыргызстан · Международный опыт',
  hero_desc:'15+ лет помогаю предпринимателям, НКО и консультантам находить финансирование, строить устойчивые организации и выходить на новый уровень.',
  cta_main:'Записаться на консультацию →',cta_res:'Ресурсы',
  stat1:'лет опыта',stat2:'привлечено',stat3:'стран-партнёров',
  roles:['консультант','тренер','фандрайзер','ментор'],
  aud_tag:'Для кого',aud_ttl:'Три типа<br><em>клиентов</em>',
  a1t:'Предприниматели и МСБ',
  a1d:'Строите бизнес, ищете инвестиции или гранты, хотите выйти на новый уровень. Нужен практик — не теоретик.',
  a1g:'💼 Платные консультации и тренинги',
  a2t:'НКО и некоммерческие',
  a2d:'Гранты, доноры, стратегия, отчётность. 15 лет в международном развитии — знаю этот мир изнутри.',
  a2g:'🤝 Тренинги · фасилитация · менторство',
  a3t:'Консультанты и эксперты',
  a3d:'Хотите запустить своё дело, углубиться в фандрайзинг или выстроить систему работы с клиентами.',
  a3g:'🎓 Менторинг · курсы · коучинг',
  svc_tag:'Что я делаю',svc_ttl:'Форматы<br><em>работы</em>',
  svc_desc:'Работаю индивидуально и в группах — от разовой консультации до долгосрочного сопровождения. Онлайн и офлайн в Бишкеке.',
  s1:'Бизнес-консалтинг',s1s:'Индивидуально · Проектно',
  s2:'Фандрайзинг и гранты',s2s:'Заявки · Стратегия · Доноры',
  s3:'Бизнес-тренинги',s3s:'Группы · Корпоративные',
  s4:'Бизнес-планирование',s4s:'Под инвестора · Под грант',
  s5:'Менторинг и акселерация',s5s:'Accelerate Prosperity · John Galt',
  s6:'Организационное развитие',s6s:'НКО · Стратегическое планирование',
  c_tag:'⭐ Популярный продукт',
  c_ttl:'Онлайн-курс<br>«Фандрайзинг с нуля<br>до <em>гранта</em>»',
  c_dsc:'Полная система поиска и привлечения финансирования — от понимания психологии доноров до отправки выигрышной заявки.',
  cf1:'6 модулей с видеоуроками',cf2:'База доноров и шаблоны заявок',
  cf3:'Живые разборы и Q&A сессии',cf4:'Сертификат по завершению',c_btn:'Подробнее о курсе →',
  pev_tag:'Мероприятия',pev_ttl:'Ближайшие<br><em>события</em>',pev_all:'Все мероприятия →',
  ev_reg:'Зарегистрироваться →',ev_up:'Скоро',ev_past:'Прошло',ev_loc:'',ev_soon:'Следующее мероприятие скоро',
  ppb_tag:'Публикации',ppb_ttl:'Руководства и<br><em>материалы</em>',ppb_all:'Все публикации →',
  pb_dl:'Скачать',pb_rd:'Читать онлайн',
  res_tag:'Ресурсы',res_ttl:'Всё в <em>одном месте</em>',
  r1t:'Курс по фандрайзингу',r1d:'От понимания доноров до выигрышной заявки.',
  r2t:'Руководство по грантам',r2d:'Пошаговый гид для тех, кто впервые ищет гранты.',
  r3t:'База данных доноров',r3d:'Каталог фондов Центральной Азии и СНГ.',
  r4t:'Тренинги Pro4Dev',r4d:'Программы для НКО и предпринимателей.',
  r5t:'Connect4KG',r5d:'Возможности финансирования для Кыргызстана.',
  r6t:'ИИ-ассистент',r6d:'Умный бот для поиска доноров. В разработке.',
  r_open:'Открыть →',r_read:'Читать →',r_view:'Смотреть →',r_sub:'Подписаться →',r_soon:'Скоро...',
  num_tag:'Цифры и опыт',num_ttl:'15 лет. Результаты<br>говорят <em>сами за себя.</em>',
  n1:'лет в международном развитии и консалтинге',n2:'привлечено финансирования',
  n3:'участников конференций из 36 стран',n4:'собственных бизнеса',
  pt_lbl:'Партнёры и доноры',
  con_tag:'Связаться',con_ttl:'Начнём<br>с <em>разговора</em>',
  con_q:'Расскажите о задаче — и мы найдём подходящий формат работы.',
  cl1:'Телефон / WhatsApp',cl4:'Локация',cl4v:'Бишкек · Работаю онлайн',
  fl_name:'Имя',fl_name_ph:'Ваше имя',fl_org:'Организация',fl_org_ph:'Компания / НКО',
  fl_type:'Я — это...',fl_msg:'Запрос',fl_msg_ph:'С чем нужна помощь?',
  fo0:'Выберите тип',fo1:'Предприниматель / МСБ',fo2:'Представитель НКО',fo3:'Консультант / Эксперт',fo4:'Другое',
  f_send:'Отправить сообщение →',
  f_note:'Откроется почтовый клиент. Или: <a href="mailto:prof4dev@gmail.com">prof4dev@gmail.com</a>',
  // events page
  ev_page_tag:'Мероприятия',ev_page_ttl:'Все<br><em>события</em>',ev_page_desc:'Тренинги, семинары и конференции. Присоединяйтесь очно или онлайн.',
  ev_filter_all:'Все',ev_filter_up:'Предстоящие',ev_filter_past:'Прошедшие',
  ev_loc_lbl:'📍',ev_lang_lbl:'🗣',ev_format_lbl:'📋',
  ev_no_events:'Мероприятия скоро появятся',
  // publications page
  pub_page_tag:'Публикации',pub_page_ttl:'Руководства и<br><em>материалы</em>',pub_page_desc:'Практические руководства на русском, кыргызском и английском языках.',
  pub_filter_all:'Все',pub_filter_ru:'Русский',pub_filter_kg:'Кыргызский',pub_filter_en:'Английский',
  pub_year:'Год',pub_available:'Доступно на:',pub_no:'Публикации скоро появятся'
},
kg:{
  nav_aud:'Кимдер үчүн',nav_svc:'Кызматтар',nav_ev:'Иш-чаралар',nav_pub:'Жарыялоолор',nav_con:'Байланыш',
  eyebrow:'Бишкек · Кыргызстан · Эл аралык тажрыйба',
  hero_desc:'15+ жыл бою ишкерлерге, ЭКУларга жана консультанттарга каржылоо табууга, туруктуу уюмдарды куруuga жана жаңы деңгээлге чыгуу үчүн жардам берип келем.',
  cta_main:'Консультацияга жазылуу →',cta_res:'Ресурстар',
  stat1:'жылдык тажрыйба',stat2:'тартылды',stat3:'өнөктөш өлкө',
  roles:['консультант','тренер','фандрайзер','ментор'],
  aud_tag:'Кимдер үчүн',aud_ttl:'Үч түрдүү<br><em>кардарлар</em>',
  a1t:'Ишкерлер жана КБИ',
  a1d:'Бизнес курасыз, инвестиция же грант издейсиз, жаңы деңгээлге чыккыңыз келет. Практик керек — теоретик эмес.',
  a1g:'💼 Акылуу консультациялар жана тренингдер',
  a2t:'ЭКУлар жана ком. эмес уюмдар',
  a2d:'Гранттар, донорлор, стратегия, отчёттуулук. Эл аралык өнүгүүдө 15 жыл — бул дүйнөнү ичинен билем.',
  a2g:'🤝 Тренингдер · фасилитация · менторлук',
  a3t:'Консультанттар жана эксперттер',
  a3d:'Өз ишиңизди баштагыңыз, фандрайзингди тереңдетүүңүз же кардарлар менен иштөө системасын түзгүңүз келет.',
  a3g:'🎓 Менторлук · курстар · коучинг',
  svc_tag:'Мен эмне кылам',svc_ttl:'Иштөө<br><em>форматтары</em>',
  svc_desc:'Жеке жана топто иштейм — бир жолку консультациядан узак мөөнөттүү кызматташтыкка чейин. Онлайн жана Бишкекте жекеме-жеке.',
  s1:'Бизнес-консалтинг',s1s:'Жеке · Долбоор боюнча',
  s2:'Фандрайзинг жана гранттар',s2s:'Арыздар · Стратегия · Донорлор',
  s3:'Бизнес-тренингдер',s3s:'Топтор · Корпоративдик',
  s4:'Бизнес-пландоо',s4s:'Инвестор үчүн · Грант үчүн',
  s5:'Менторлук жана акселерация',s5s:'Accelerate Prosperity · John Galt',
  s6:'Уюмдук өнүгүү',s6s:'ЭКУлар · Стратегиялык пландоо',
  c_tag:'⭐ Популярдуу продукт',
  c_ttl:'Онлайн-курс<br>«Нөлдөн<br><em>грантка</em> чейин»',
  c_dsc:'Каржылоону табуу жана тартуунун толук системасы — донорлордун психологиясын түшүнүүдөн жеңүүчү арызды жөнөтүүгө чейин.',
  cf1:'6 видео сабактуу модуль',cf2:'Донорлор базасы жана арыз үлгүлөрү',
  cf3:'Тирүү талдоолор жана Q&A сессиялар',cf4:'Аяктагандан кийин сертификат',c_btn:'Курс жөнүндө толук →',
  pev_tag:'Иш-чаралар',pev_ttl:'Жакынкы<br><em>окуялар</em>',pev_all:'Бардык иш-чаралар →',
  ev_reg:'Катталуу →',ev_up:'Жакында',ev_past:'Өттү',ev_loc:'',ev_soon:'Кийинки иш-чара жакында',
  ppb_tag:'Жарыялоолор',ppb_ttl:'Колдонмолор жана<br><em>материалдар</em>',ppb_all:'Бардык жарыялоолор →',
  pb_dl:'Жүктөп алуу',pb_rd:'Онлайн окуу',
  res_tag:'Ресурстар',res_ttl:'Баары <em>бир жерде</em>',
  r1t:'Фандрайзинг курсу',r1d:'Донорлорду түшүнүүдөн жеңүүчү арызга чейин.',
  r2t:'Грант боюнча колдонмо',r2d:'Биринчи жолу грант издегендер үчүн кадамдык нускама.',
  r3t:'Донорлор маалымат базасы',r3d:'Борбор Азия жана КМШдагы фонддор каталогу.',
  r4t:'Pro4Dev тренингдери',r4d:'ЭКУлар жана ишкерлер үчүн программалар.',
  r5t:'Connect4KG',r5d:'Кыргызстан үчүн актуалдуу каржылоо мүмкүнчүлүктөрү.',
  r6t:'ЖИ-жардамчы',r6d:'Донор издөө боюнча акылдуу бот. Иштеп жатат.',
  r_open:'Ачуу →',r_read:'Окуу →',r_view:'Көрүү →',r_sub:'Жазылуу →',r_soon:'Жакында...',
  num_tag:'Сандар жана тажрыйба',num_ttl:'15 жыл. Натыйжалар<br>өзү <em>сүйлөйт.</em>',
  n1:'эл аралык өнүгүү жана консалтингдеги жыл',n2:'тартылган каржылоо',
  n3:'катышуучулар 36 өлкөдөн',n4:'өз бизнеси',
  pt_lbl:'Өнөктөштөр жана донорлор',
  con_tag:'Байланыш',con_ttl:'Маектен<br><em>баштайлы</em>',
  con_q:'Милдетиңиз жөнүндө айтып бериңиз — биз ылайыктуу форматты табабыз.',
  cl1:'Телефон / WhatsApp',cl4:'Жайгашкан жер',cl4v:'Бишкек · Онлайн иштейм',
  fl_name:'Аты',fl_name_ph:'Атыңыз',fl_org:'Уюм',fl_org_ph:'Компания / ЭКУ',
  fl_type:'Мен...',fl_msg:'Суроо',fl_msg_ph:'Эмнеде жардам керек?',
  fo0:'Түрүн тандаңыз',fo1:'Ишкер / КБИ',fo2:'ЭКУ өкүлү',fo3:'Консультант / Эксперт',fo4:'Башка',
  f_send:'Билдирүү жөнөтүү →',
  f_note:'Почта кардарыңыз ачылат. Же: <a href="mailto:prof4dev@gmail.com">prof4dev@gmail.com</a>',
  ev_page_tag:'Иш-чаралар',ev_page_ttl:'Бардык<br><em>окуялар</em>',ev_page_desc:'Тренингдер, семинарлар жана конференциялар. Жекеме-жеке же онлайн катышыңыз.',
  ev_filter_all:'Баары',ev_filter_up:'Жакынкы',ev_filter_past:'Өткөн',
  ev_loc_lbl:'📍',ev_lang_lbl:'🗣',ev_format_lbl:'📋',ev_no_events:'Иш-чаралар жакында болот',
  pub_page_tag:'Жарыялоолор',pub_page_ttl:'Колдонмолор жана<br><em>материалдар</em>',pub_page_desc:'Кыргыз, орус жана англис тилдериндеги практикалык колдонмолор.',
  pub_filter_all:'Баары',pub_filter_ru:'Орусча',pub_filter_kg:'Кыргызча',pub_filter_en:'Англисче',
  pub_year:'Жыл',pub_available:'Жеткиликтүү:',pub_no:'Жарыялоолор жакында болот'
},
en:{
  nav_aud:"Who it's for",nav_svc:'Services',nav_ev:'Events',nav_pub:'Publications',nav_con:'Contact',
  eyebrow:'Bishkek · Kyrgyzstan · International experience',
  hero_desc:'15+ years helping entrepreneurs, NGOs and consultants secure funding, build resilient organizations and reach the next level.',
  cta_main:'Book a consultation →',cta_res:'Resources',
  stat1:'years of experience',stat2:'raised',stat3:'partner countries',
  roles:['consultant','trainer','fundraiser','mentor'],
  aud_tag:"Who it's for",aud_ttl:'Three types of<br><em>clients</em>',
  a1t:'Entrepreneurs & SMEs',
  a1d:"Building a business, seeking investment or grants, ready for the next level. You need a practitioner — not a theorist.",
  a1g:'💼 Paid consultations & trainings',
  a2t:'NGOs & Non-profits',
  a2d:"Grants, donors, strategy, reporting. 15 years in international development — I know this world from the inside.",
  a2g:'🤝 Trainings · facilitation · mentorship',
  a3t:'Consultants & Experts',
  a3d:"Want to launch your own practice, go deeper in fundraising or build a client management system.",
  a3g:'🎓 Mentoring · courses · coaching',
  svc_tag:'What I do',svc_ttl:'Service<br><em>formats</em>',
  svc_desc:"I work individually and in groups — from a single consultation to long-term partnership. Online and in-person in Bishkek.",
  s1:'Business consulting',s1s:'Individual · Project-based',
  s2:'Fundraising & grants',s2s:'Applications · Strategy · Donors',
  s3:'Business trainings',s3s:'Groups · Corporate',
  s4:'Business planning',s4s:'For investors · For grants',
  s5:'Mentoring & acceleration',s5s:'Accelerate Prosperity · John Galt',
  s6:'Organizational development',s6s:'NGOs · Strategic planning',
  c_tag:'⭐ Popular product',
  c_ttl:'Online course<br>«Fundraising from zero<br>to <em>grant</em>»',
  c_dsc:'A complete system for finding and securing funding — from understanding donor psychology to submitting a winning application.',
  cf1:'6 modules with video lessons',cf2:'Donor database & application templates',
  cf3:'Live case reviews & Q&A sessions',cf4:'Certificate upon completion',c_btn:'Learn more →',
  pev_tag:'Events',pev_ttl:'Upcoming<br><em>events</em>',pev_all:'All events →',
  ev_reg:'Register →',ev_up:'Upcoming',ev_past:'Past',ev_loc:'',ev_soon:'Next event coming soon',
  ppb_tag:'Publications',ppb_ttl:'Guides &<br><em>materials</em>',ppb_all:'All publications →',
  pb_dl:'Download',pb_rd:'Read online',
  res_tag:'Resources',res_ttl:'Everything in <em>one place</em>',
  r1t:'Fundraising course',r1d:'From understanding donors to a winning grant application.',
  r2t:'Grant writing guide',r2d:"Step-by-step guide for first-time grant seekers.",
  r3t:'Donor database',r3d:'Directory of foundations active in Central Asia.',
  r4t:'Pro4Dev trainings',r4d:'Programs for NGOs and entrepreneurs.',
  r5t:'Connect4KG',r5d:'Current funding opportunities for Kyrgyzstan.',
  r6t:'AI assistant',r6d:'Smart bot for finding donors. Coming soon.',
  r_open:'Open →',r_read:'Read →',r_view:'View →',r_sub:'Subscribe →',r_soon:'Coming soon...',
  num_tag:'Track record',num_ttl:'15 years. Results<br>speak <em>for themselves.</em>',
  n1:'years in international development & consulting',n2:'raised in funding',
  n3:'conference participants from 36 countries',n4:'own businesses',
  pt_lbl:'Partners & donors',
  con_tag:'Contact',con_ttl:"Let's start<br>with a <em>conversation</em>",
  con_q:"Tell me about your challenge — and we'll find the right format.",
  cl1:'Phone / WhatsApp',cl4:'Location',cl4v:'Bishkek · Available online',
  fl_name:'Name',fl_name_ph:'Your name',fl_org:'Organization',fl_org_ph:'Company / NGO',
  fl_type:'I am a...',fl_msg:'Request',fl_msg_ph:'What do you need help with?',
  fo0:'Select type',fo1:'Entrepreneur / SME',fo2:'NGO representative',fo3:'Consultant / Expert',fo4:'Other',
  f_send:'Send message →',
  f_note:'This will open your mail client. Or: <a href="mailto:prof4dev@gmail.com">prof4dev@gmail.com</a>',
  ev_page_tag:'Events',ev_page_ttl:'All<br><em>events</em>',ev_page_desc:'Trainings, workshops and conferences. Join in-person or online.',
  ev_filter_all:'All',ev_filter_up:'Upcoming',ev_filter_past:'Past',
  ev_loc_lbl:'📍',ev_lang_lbl:'🗣',ev_format_lbl:'📋',ev_no_events:'Events coming soon',
  pub_page_tag:'Publications',pub_page_ttl:'Guides &<br><em>materials</em>',pub_page_desc:'Practical guides in Russian, Kyrgyz and English.',
  pub_filter_all:'All',pub_filter_ru:'Russian',pub_filter_kg:'Kyrgyz',pub_filter_en:'English',
  pub_year:'Year',pub_available:'Available in:',pub_no:'Publications coming soon'
}};

/* ═══════════════════════════════
   LANG LABEL MAP
═══════════════════════════════ */
const LANG_LABEL = {ru:'RU',kg:'КЫР',en:'EN'};

/* ═══════════════════════════════
   RENDER CARDS
═══════════════════════════════ */
function renderEvCards(container, events, lang){
  if(!container) return;
  const t = T[lang];
  const items = events.map(ev=>{
    const badge = ev.status==='upcoming'
      ? `<span class="card-badge badge-up">${t.ev_up}</span>`
      : `<span class="card-badge badge-past">${t.ev_past}</span>`;
    const dateStr = lang==='kg' ? ev.date_kg : lang==='en' ? ev.date_en : ev.date;
    return `<div class="card">
      ${badge}
      <div class="card-date">${dateStr}</div>
      <div class="card-ttl">${ev.title[lang]||ev.title.ru}</div>
      <div class="card-desc">${ev.desc[lang]||ev.desc.ru}</div>
      <div class="card-date" style="margin-bottom:16px">📍 ${ev.location[lang]||ev.location.ru}</div>
      <a href="${ev.register}" target="_blank" class="card-lnk">${t.ev_reg}</a>
    </div>`;
  });
  while(items.length < 3) items.push(`<div class="card card-empty"><div class="card-desc" style="color:var(--muted);padding-top:20px;text-align:center">${t.ev_soon}</div></div>`);
  container.innerHTML = items.slice(0,3).join('');
}

function renderPubCards(container, pubs, lang){
  if(!container) return;
  const t = T[lang];
  container.innerHTML = pubs.slice(0,3).map(p=>{
    const pills = p.langs.map(lg=>`<span class="lang-pill">${LANG_LABEL[lg]}</span>`).join('');
    const btns = p.langs.map(lg=>{
      const f = p.files[lg];
      if(!f) return '';
      const isPrimary = lg===lang ? ' primary' : '';
      return `<a href="${f}" class="pub-btn${isPrimary}" download>${t.pb_dl} ${LANG_LABEL[lg]}</a>`;
    }).filter(Boolean).join('');
    return `<div class="card">
      <div class="card-date">${p.year}</div>
      <div class="card-langs">${pills}</div>
      <div class="card-ttl">${p.title[lang]||p.title.ru}</div>
      <div class="card-desc">${p.desc[lang]||p.desc.ru}</div>
      <div class="pub-btns">${btns}</div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════
   SET LANGUAGE
═══════════════════════════════ */
let _lang = 'ru';
let _roleIdx = 0, _roleTimer;
let _onLangChange = null;
let _pageData = {};

function setLang(l){
  _lang = l;
  const t = T[l];
  document.documentElement.lang = l;
  ['ru','kg','en'].forEach(id=>{
    const btn = document.getElementById('lb-'+id);
    if(btn) btn.classList.toggle('active', id===l);
  });

  // Update text nodes
  document.querySelectorAll('[data-i]').forEach(el=>{
    const k=el.dataset.i, v=t[k];
    if(v===undefined) return;
    const richKeys=['aud_ttl','svc_ttl','c_ttl','num_ttl','con_ttl','pev_ttl','ppb_ttl','res_ttl','f_note',
                    'ev_page_ttl','pub_page_ttl'];
    if(richKeys.includes(k)) el.innerHTML=v; else el.textContent=v;
  });

  // Placeholders
  document.querySelectorAll('[data-ph]').forEach(el=>{
    const v=t[el.dataset.ph]; if(v) el.placeholder=v;
  });

  // Roles (index only)
  const rc=document.getElementById('rc');
  if(rc){
    clearInterval(_roleTimer);
    _roleIdx=0;
    rc.textContent=t.roles[0];
    _roleTimer=setInterval(()=>{
      rc.style.opacity='0';rc.style.transform='translateY(-10px)';
      setTimeout(()=>{
        _roleIdx=(_roleIdx+1)%t.roles.length;
        rc.textContent=t.roles[_roleIdx];
        rc.style.transform='translateY(10px)';
        requestAnimationFrame(()=>requestAnimationFrame(()=>{rc.style.opacity='1';rc.style.transform='translateY(0)'}));
      },320);
    },2800);
  }

  // Re-render dynamic cards
  if(_onLangChange) _onLangChange(l);

  // Title
  document.title = l==='en'
    ? 'Azat Israilov — Consultant · Trainer · Fundraiser'
    : l==='kg'
    ? 'Азат Исраилов — Консультант · Тренер · Фандрайзер'
    : 'Азат Исраилов — Консультант · Тренер · Фандрайзер';
}

/* ═══════════════════════════════
   INIT
═══════════════════════════════ */
function initPage(opts){
  opts = opts || {};
  _pageData = opts;

  // NAV scroll
  const nb=document.getElementById('nb');
  if(nb) window.addEventListener('scroll',()=>nb.classList.toggle('scrolled',scrollY>50),{passive:true});

  // Mobile nav
  window.navToggle = function(){ document.getElementById('nl').classList.toggle('open') };
  document.querySelectorAll('.nl a').forEach(a=>a.addEventListener('click',()=>{
    const nl=document.getElementById('nl'); if(nl) nl.classList.remove('open');
  }));

  // Scroll reveal
  const obs = new IntersectionObserver(
    entries=>entries.forEach(e=>e.isIntersecting&&e.target.classList.add('vis')),
    {threshold:.08}
  );
  document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));

  // Set lang change callback
  _onLangChange = function(l){
    if(opts.eventsData){
      renderEvCards(document.getElementById('ev-cards'), opts.eventsData, l);
    }
    if(opts.pubsData){
      renderPubCards(document.getElementById('pub-cards'), opts.pubsData, l);
    }
    if(opts.onLang) opts.onLang(l);
  };

  // Init lang
  setLang('ru');

  // Contact form
  window.sendMail = function(e){
    e.preventDefault();
    const n=document.getElementById('fn').value,
          o=document.getElementById('fo').value,
          em=document.getElementById('fe').value,
          tp=document.getElementById('ft').value,
          m=document.getElementById('fm').value;
    const subj=_lang==='en'?`Website inquiry — ${n}`:`Запрос с сайта — ${n}`;
    const body=_lang==='en'?`Name: ${n}\nOrg: ${o}\nEmail: ${em}\nType: ${tp}\n\n${m}`:`Имя: ${n}\nОрг: ${o}\nEmail: ${em}\nТип: ${tp}\n\n${m}`;
    window.location.href=`mailto:prof4dev@gmail.com?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
  };
}

/* expose */
window.T=T; window.LANG_LABEL=LANG_LABEL;
window.setLang=setLang; window.initPage=initPage;
window.renderEvCards=renderEvCards; window.renderPubCards=renderPubCards;
