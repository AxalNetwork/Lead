-- Task #3: Concrete public starting points for the in-house crawler.
--
-- Idempotent: keyed on (profile_type_id, seed_kind, value) UNIQUE.
-- INSERT OR REPLACE lets the migration re-run as the seed list evolves.
--
-- Every seed targets a profile_type_id that already exists in e_types
-- (FK enforced). All sources are PUBLIC pages — no auth, no commercial
-- APIs. Adding a new family of seeds is a matter of appending rows here.

INSERT OR REPLACE INTO crawler_seeds (id, profile_type_id, seed_kind, value, refresh_interval_hours, enabled, notes) VALUES
-- ── investor_vc ────────────────────────────────────────────────────────
('seed_vc_nvca_members',           'investor_vc',          'url',           'https://nvca.org/about-us/membership/member-directory/',                  168, 1, 'NVCA member directory'),
('seed_vc_wikipedia_list',         'investor_vc',          'url',           'https://en.wikipedia.org/wiki/List_of_venture_capital_firms',             720, 1, 'Wikipedia: List of venture capital firms'),
('seed_vc_a16z_team',              'investor_vc',          'url',           'https://a16z.com/team/',                                                   168, 1, 'a16z team roster'),
('seed_vc_sequoia_people',         'investor_vc',          'url',           'https://www.sequoiacap.com/people/',                                       168, 1, 'Sequoia partners'),
('seed_vc_benchmark_team',         'investor_vc',          'url',           'https://www.benchmark.com/team/',                                          168, 1, 'Benchmark team'),
('seed_vc_accel_team',             'investor_vc',          'url',           'https://www.accel.com/people',                                             168, 1, 'Accel team'),
('seed_vc_gv_team',                'investor_vc',          'url',           'https://www.gv.com/team/',                                                 168, 1, 'GV (Google Ventures) team'),
('seed_vc_firstround_partners',    'investor_vc',          'url',           'https://firstround.com/people/',                                           168, 1, 'First Round partners'),
('seed_vc_kpcb_team',              'investor_vc',          'url',           'https://www.kleinerperkins.com/people/',                                   168, 1, 'Kleiner Perkins team'),
('seed_vc_search_top_firms',       'investor_vc',          'search_query',  'top venture capital firms 2026 partners list',                              720, 1, 'Bootstrap search'),

-- ── investor_angel ─────────────────────────────────────────────────────
('seed_angel_aca_directory',       'investor_angel',       'url',           'https://www.angelcapitalassociation.org/directory/',                       336, 1, 'Angel Capital Association directory'),
('seed_angel_wikipedia',           'investor_angel',       'url',           'https://en.wikipedia.org/wiki/Angel_investor',                             720, 1, 'Wikipedia: Angel investor'),
('seed_angel_search_top',          'investor_angel',       'search_query',  'most active angel investors 2026',                                          720, 1, 'Bootstrap search'),

-- ── investor_corporate_vc ──────────────────────────────────────────────
('seed_cvc_wikipedia',             'investor_corporate_vc','url',           'https://en.wikipedia.org/wiki/Corporate_venture_capital',                  720, 1, 'Wikipedia: CVC'),
('seed_cvc_search_units',          'investor_corporate_vc','search_query',  'corporate venture capital units 2026 directory',                            720, 1, 'Bootstrap search'),

-- ── investor_pe ────────────────────────────────────────────────────────
('seed_pe_wikipedia',              'investor_pe',          'url',           'https://en.wikipedia.org/wiki/List_of_private_equity_firms',               720, 1, 'Wikipedia: List of PE firms'),
('seed_pe_search_top',             'investor_pe',          'search_query',  'top private equity firms 2026 partners',                                    720, 1, 'Bootstrap search'),

-- ── fund_of_funms / endowment / sovereign / pension ────────────────────
('seed_fof_wikipedia',             'fund_of_funds',        'url',           'https://en.wikipedia.org/wiki/Fund_of_funds',                              720, 1, 'Wikipedia: Fund of funds'),
('seed_endowment_wikipedia',       'investor_endowment',   'url',           'https://en.wikipedia.org/wiki/Financial_endowment',                        720, 1, 'Wikipedia: Endowment'),
('seed_sovereign_swfi',            'investor_sovereign',   'url',           'https://www.swfinstitute.org/fund-rankings/sovereign-wealth-fund',         720, 1, 'SWF Institute rankings'),
('seed_pension_top_us',            'investor_pension',     'search_query',  'top US public pension funds private equity allocations',                    720, 1, 'Bootstrap search'),

-- ── accelerator / incubator / venture_studio / syndicate ───────────────
('seed_acc_yc_companies',          'accelerator',          'url',           'https://www.ycombinator.com/companies',                                    168, 1, 'YC company directory'),
('seed_acc_techstars',             'accelerator',          'url',           'https://www.techstars.com/portfolio',                                      168, 1, 'Techstars portfolio'),
('seed_acc_wikipedia',             'accelerator',          'url',           'https://en.wikipedia.org/wiki/Startup_accelerator',                        720, 1, 'Wikipedia: Accelerator'),
('seed_incubator_wikipedia',       'incubator',            'url',           'https://en.wikipedia.org/wiki/Business_incubator',                         720, 1, 'Wikipedia: Incubator'),
('seed_studio_wikipedia',          'venture_studio',       'url',           'https://en.wikipedia.org/wiki/Venture_builder',                            720, 1, 'Wikipedia: Venture studio'),
('seed_syndicate_angellist',       'syndicate',            'url',           'https://www.angellist.com/syndicates',                                     168, 1, 'AngelList syndicates'),

-- ── gp_partner / venture_partner / principal / associate / scout / EIR ─
('seed_gp_search',                 'gp_partner',           'search_query',  'general partner venture capital biography',                                 720, 1, 'Bootstrap search'),
('seed_vp_search',                 'venture_partner',      'search_query',  'venture partner role definition firms',                                     720, 1, 'Bootstrap search'),
('seed_principal_search',          'principal',            'search_query',  'venture capital principal title firms 2026',                                720, 1, 'Bootstrap search'),
('seed_assoc_search',              'associate',            'search_query',  'venture capital associate title firms 2026',                                720, 1, 'Bootstrap search'),
('seed_scout_search',              'scout',                'search_query',  'venture capital scout program list',                                        720, 1, 'Bootstrap search'),
('seed_eir_search',                'entrepreneur_in_residence','search_query','entrepreneur in residence venture capital firm 2026',                     720, 1, 'Bootstrap search'),

-- ── lawyer (securities, corporate, IP, employment, immigration, tax) ───
('seed_law_amlaw_100',             'law_firm',             'url',           'https://www.law.com/americanlawyer/rankings/the-2024-am-law-100/',         720, 1, 'AmLaw 100 rankings'),
('seed_law_sec_securities',        'lawyer_securities',    'url',           'https://www.sec.gov/divisions/enforce/enforcementdivisionleadership.htm',  720, 1, 'SEC Enforcement leadership'),
('seed_law_chambers',              'lawyer_corporate',     'url',           'https://chambers.com/rankings',                                            720, 1, 'Chambers public rankings'),
('seed_law_ip_uspto',              'lawyer_ip',            'url',           'https://oedci.uspto.gov/OEDCI/practitionerSearchEntry',                    720, 1, 'USPTO registered practitioners'),
('seed_law_employment_search',     'lawyer_employment',    'search_query',  'top employment lawyers 2026 startups',                                      720, 1, 'Bootstrap search'),
('seed_law_immigration_search',    'lawyer_immigration',   'search_query',  'top startup immigration lawyers H1B 2026',                                 720, 1, 'Bootstrap search'),
('seed_law_tax_search',            'lawyer_tax',           'search_query',  'top startup tax lawyers QSBS 2026',                                         720, 1, 'Bootstrap search'),

-- ── banker (investment / commercial / private / M&A) ───────────────────
('seed_bank_investment_wiki',      'banker_investment',    'url',           'https://en.wikipedia.org/wiki/List_of_investment_banks',                   720, 1, 'Wikipedia: Investment banks'),
('seed_bank_mna_league',           'banker_m_and_a',       'search_query',  'M&A league tables 2026 advisors',                                           720, 1, 'Bootstrap search'),
('seed_bank_private_wiki',         'banker_private',       'url',           'https://en.wikipedia.org/wiki/Private_banking',                            720, 1, 'Wikipedia: Private banking'),
('seed_bank_commercial_wiki',      'banker_commercial',    'url',           'https://en.wikipedia.org/wiki/List_of_largest_banks_in_the_United_States', 720, 1, 'Wikipedia: Largest US banks'),

-- ── operator (growth/sales/marketing/product/eng + fractional + recruiter)
('seed_op_growth_search',          'operator_growth',      'search_query',  'top growth marketers startups 2026',                                        720, 1, 'Bootstrap search'),
('seed_op_sales_search',           'operator_sales',       'search_query',  'top startup VP sales SaaS 2026',                                            720, 1, 'Bootstrap search'),
('seed_op_marketing_search',       'operator_marketing',   'search_query',  'top startup marketing leaders 2026',                                        720, 1, 'Bootstrap search'),
('seed_op_product_search',         'operator_product',     'search_query',  'top startup product leaders 2026',                                          720, 1, 'Bootstrap search'),
('seed_op_eng_search',             'operator_engineering', 'search_query',  'top startup engineering VPs 2026',                                          720, 1, 'Bootstrap search'),
('seed_frac_cfo_search',           'fractional_cfo',       'search_query',  'fractional CFO startup 2026',                                               720, 1, 'Bootstrap search'),
('seed_frac_cto_search',           'fractional_cto',       'search_query',  'fractional CTO startup 2026',                                               720, 1, 'Bootstrap search'),
('seed_frac_coo_search',           'fractional_coo',       'search_query',  'fractional COO startup 2026',                                               720, 1, 'Bootstrap search'),
('seed_frac_cmo_search',           'fractional_cmo',       'search_query',  'fractional CMO startup 2026',                                               720, 1, 'Bootstrap search'),
('seed_recruiter_search',          'executive_recruiter',  'search_query',  'top executive search firms startups 2026',                                  720, 1, 'Bootstrap search'),

-- ── founders (solo, co_founder, repeat, founding eng/des/pm, technical) ─
('seed_founder_yc',                'founder',              'url',           'https://www.ycombinator.com/companies',                                    168, 1, 'YC founders directory'),
('seed_founder_producthunt',       'founder',              'url',           'https://www.producthunt.com/makers',                                       168, 1, 'ProductHunt makers'),
('seed_repeat_search',             'repeat_founder',       'search_query',  'repeat founder second startup 2026',                                        720, 1, 'Bootstrap search'),
('seed_serial_search',             'serial_entrepreneur',  'search_query',  'serial entrepreneur multiple exits',                                        720, 1, 'Bootstrap search'),
('seed_founding_eng_search',       'founding_engineer',    'search_query',  'founding engineer startup hiring 2026',                                     720, 1, 'Bootstrap search'),
('seed_founding_des_search',       'founding_designer',    'search_query',  'founding designer startup 2026',                                            720, 1, 'Bootstrap search'),
('seed_founding_pm_search',        'founding_pm',          'search_query',  'founding product manager startup 2026',                                     720, 1, 'Bootstrap search'),

-- ── press / journalism / podcasts / newsletters / youtube ──────────────
('seed_press_techcrunch_authors',  'journalist_tech',      'url',           'https://techcrunch.com/about/staff/',                                      168, 1, 'TechCrunch staff'),
('seed_press_information_team',    'journalist_tech',      'url',           'https://www.theinformation.com/team',                                      336, 1, 'The Information team'),
('seed_press_wsj_business',        'journalist_business',  'url',           'https://www.wsj.com/news/business',                                        168, 1, 'WSJ Business'),
('seed_press_coindesk_authors',    'journalist_crypto',    'url',           'https://www.coindesk.com/authors/',                                        168, 1, 'Coindesk authors'),
('seed_podcast_search_vc',         'podcast_host',         'search_query',  'top venture capital podcasts hosts 2026',                                   720, 1, 'Bootstrap search'),
('seed_newsletter_substack_vc',    'newsletter_writer',    'url',           'https://substack.com/discover/category/business',                          168, 1, 'Substack: Business discover'),
('seed_youtube_search_vc',         'youtuber_business',    'search_query',  'top venture capital YouTube channels 2026',                                 720, 1, 'Bootstrap search'),
('seed_thought_leader_search',     'thought_leader',       'search_query',  'startup thought leaders 2026',                                              720, 1, 'Bootstrap search'),
('seed_conf_organizer_search',     'conference_organizer', 'search_query',  'top startup tech conferences 2026 organizers',                              720, 1, 'Bootstrap search'),

-- ── public sector (federal/state/local + policy + agencies) ────────────
('seed_pol_fed_congress',          'politician_federal',   'url',           'https://www.congress.gov/members',                                         168, 1, 'Congress.gov members'),
('seed_pol_fed_senate',            'politician_federal',   'url',           'https://www.senate.gov/senators/',                                         168, 1, 'US Senate roster'),
('seed_pol_state_ncsl',            'politician_state',     'url',           'https://www.ncsl.org/about-state-legislatures',                            720, 1, 'NCSL state legislatures'),
('seed_pol_local_search',          'politician_local',     'search_query',  'major US city mayors 2026 list',                                            720, 1, 'Bootstrap search'),
('seed_policy_adv_search',         'policy_advisor',       'search_query',  'tech policy advisors think tanks 2026',                                     720, 1, 'Bootstrap search'),
('seed_gov_fed_darpa',             'government_agency_federal','url',        'https://www.darpa.mil/about-us/people',                                    720, 1, 'DARPA program managers'),
('seed_gov_fed_arpae',             'government_agency_federal','url',        'https://arpa-e.energy.gov/about/leadership-and-staff',                     720, 1, 'ARPA-E leadership'),
('seed_gov_fed_nsf',               'government_agency_federal','url',        'https://www.nsf.gov/staff/staff_list.jsp',                                 720, 1, 'NSF staff'),
('seed_gov_state_search',          'government_agency_state','search_query', 'US state economic development agencies 2026',                              720, 1, 'Bootstrap search'),
('seed_gov_local_search',          'government_agency_local','search_query', 'US city economic development office',                                      720, 1, 'Bootstrap search'),
('seed_multilateral_wb',           'multilateral_org',     'url',           'https://www.worldbank.org/en/about/leadership',                            720, 1, 'World Bank leadership'),
('seed_ngo_search',                'ngo',                  'search_query',  'top tech-focused NGOs 2026',                                                720, 1, 'Bootstrap search'),
('seed_think_tank_brookings',      'think_tank',           'url',           'https://www.brookings.edu/experts/',                                       720, 1, 'Brookings experts'),

-- ── academic (professors, postdocs, PhD students, labs, TTOs) ──────────
('seed_acad_arxiv_recent',         'professor',            'url',           'https://arxiv.org/list/cs.AI/recent',                                      24,  1, 'arXiv cs.AI recent'),
('seed_acad_semanticscholar_ai',   'professor',            'url',           'https://www.semanticscholar.org/topic/Artificial-intelligence/40',         168, 1, 'Semantic Scholar: AI'),
('seed_acad_pubmed_recent',        'professor',            'url',           'https://pubmed.ncbi.nlm.nih.gov/?term=biotech&sort=date',                  168, 1, 'PubMed: biotech recent'),
('seed_acad_postdoc_search',       'postdoc',              'search_query',  'top AI postdoctoral researchers 2026',                                      720, 1, 'Bootstrap search'),
('seed_acad_phd_search',           'phd_student',          'search_query',  'top AI PhD students 2026',                                                  720, 1, 'Bootstrap search'),
('seed_acad_lab_pi_search',        'lab_principal_investigator','search_query','top AI lab principal investigators universities 2026',                  720, 1, 'Bootstrap search'),
('seed_acad_tto_autm',             'technology_transfer_officer','url',     'https://autm.net/about-autm/leadership',                                   720, 1, 'AUTM leadership'),
('seed_acad_research_search',      'research_scientist',   'search_query',  'top industrial research scientists AI 2026',                                720, 1, 'Bootstrap search'),

-- ── companies (startups by stage, public, SME/enterprise, portcos) ─────
('seed_co_yc_startups',            'startup_seed',         'url',           'https://www.ycombinator.com/companies?batch=W26',                          168, 1, 'YC W26 startups'),
('seed_co_series_a_search',        'startup_series_a',     'search_query',  'startups that raised series A 2026',                                        168, 1, 'Bootstrap search'),
('seed_co_growth_search',          'startup_growth',       'search_query',  'startups series C growth 2026',                                             168, 1, 'Bootstrap search'),
('seed_co_late_search',            'startup_late_stage',   'search_query',  'late stage private tech companies 2026',                                    168, 1, 'Bootstrap search'),
('seed_co_public_sec',             'public_company',       'url',           'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=10-K',     720, 1, 'SEC EDGAR public filers'),
('seed_co_acquirer_search',        'acquirer_strategic',   'search_query',  'most active strategic acquirers tech 2026',                                 720, 1, 'Bootstrap search'),

-- ── service firms (accounting, consulting, PR, marketing, exec search) ─
('seed_acct_big4',                 'accounting_firm',      'url',           'https://en.wikipedia.org/wiki/Big_Four_accounting_firms',                  720, 1, 'Wikipedia: Big Four'),
('seed_consult_mbb',               'consulting_firm',      'url',           'https://en.wikipedia.org/wiki/Management_consulting',                      720, 1, 'Wikipedia: Management consulting'),
('seed_pr_search',                 'pr_firm',              'search_query',  'top tech PR firms 2026',                                                    720, 1, 'Bootstrap search'),
('seed_marketing_agency_search',   'marketing_agency',     'search_query',  'top tech marketing agencies 2026',                                          720, 1, 'Bootstrap search'),
('seed_exec_search_firm',          'executive_search_firm','url',           'https://en.wikipedia.org/wiki/Executive_search',                           720, 1, 'Wikipedia: Executive search'),
('seed_design_agency_search',      'design_agency',        'search_query',  'top product design agencies startups 2026',                                 720, 1, 'Bootstrap search'),
('seed_dev_shop_search',           'dev_shop',             'search_query',  'top software development agencies startups 2026',                           720, 1, 'Bootstrap search'),

-- ── advisory / board / industry analysts ───────────────────────────────
('seed_advisor_search',            'advisor',              'search_query',  'top startup advisors 2026',                                                 720, 1, 'Bootstrap search'),
('seed_board_search',              'board_member',         'search_query',  'startup board members public companies 2026',                               720, 1, 'Bootstrap search'),
('seed_analyst_gartner',           'analyst_industry',     'url',           'https://www.gartner.com/en/research/methodologies/magic-quadrants-research',720, 1, 'Gartner Magic Quadrants'),

-- ── financial infrastructure (exchanges, custodians, clearing, payments)
('seed_exch_nyse',                 'exchange_traditional', 'url',           'https://www.nyse.com/listings_directory/stock',                            720, 1, 'NYSE listings'),
('seed_exch_nasdaq',               'exchange_traditional', 'url',           'https://www.nasdaq.com/market-activity/stocks/screener',                   720, 1, 'Nasdaq screener'),
('seed_exch_crypto_search',        'exchange_crypto',      'search_query',  'top crypto exchanges 2026',                                                 720, 1, 'Bootstrap search'),
('seed_custodian_search',          'custodian',            'search_query',  'top securities custodian banks 2026',                                       720, 1, 'Bootstrap search'),
('seed_payments_search',           'payment_processor',    'search_query',  'top payment processors 2026',                                               720, 1, 'Bootstrap search'),
('seed_clearing_search',           'clearinghouse',        'search_query',  'top clearinghouses derivatives 2026',                                       720, 1, 'Bootstrap search');
