-- Sample terminology for development and testing ONLY.
--
-- A few dozen common concepts so the mapping step has candidates to offer. It is NOT a licensed or complete
-- terminology: the codes and display names below were written from memory for testing and must be checked against
-- the official releases before this system touches real data. SNOMED CT is licensed (free in member countries
-- such as India through the national release centre); LOINC is free under its licence; ICD-10 is published by the
-- WHO. For production, load the official releases instead of this file.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and run. Safe to run again: it updates what it already inserted.
--
-- resource_types limits where a concept is offered (empty = anywhere): diagnoses to Condition, drugs to
-- MedicationRequest and AllergyIntolerance, procedures to Procedure, lab tests to Observation and DiagnosticReport.

insert into public.terminology_concepts (system, code, display, synonyms, resource_types) values
  -- SNOMED CT: disorders
  ('snomed', '44054006',  'Diabetes mellitus type 2',                 array['type 2 diabetes mellitus','type 2 diabetes','t2dm','niddm','adult onset diabetes'], array['Condition']),
  ('snomed', '73211009',  'Diabetes mellitus',                        array['diabetes','dm'], array['Condition']),
  ('snomed', '38341003',  'Hypertensive disorder, systemic arterial', array['hypertension','high blood pressure','htn'], array['Condition']),
  ('snomed', '195967001', 'Asthma',                                   array['bronchial asthma'], array['Condition']),
  ('snomed', '13645005',  'Chronic obstructive lung disease',         array['copd','chronic obstructive pulmonary disease'], array['Condition']),
  ('snomed', '22298006',  'Myocardial infarction',                    array['heart attack','mi','acute myocardial infarction'], array['Condition']),
  ('snomed', '84114007',  'Heart failure',                            array['cardiac failure','congestive heart failure','chf'], array['Condition']),
  ('snomed', '49436004',  'Atrial fibrillation',                      array['af','afib'], array['Condition']),
  ('snomed', '233604007', 'Pneumonia',                                array['lung infection'], array['Condition']),
  ('snomed', '40930008',  'Hypothyroidism',                           array['underactive thyroid'], array['Condition']),
  ('snomed', '709044004', 'Chronic kidney disease',                   array['ckd','chronic renal disease'], array['Condition']),

  -- SNOMED CT: substances (medications, and allergens)
  ('snomed', '372567009', 'Metformin',      array['metformin hydrochloride','glucophage','glycomet'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '387458008', 'Aspirin',        array['acetylsalicylic acid','ecosprin','asa'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '386864001', 'Amlodipine',     array['amlong','norvasc'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '373444002', 'Atorvastatin',   array['storvas','lipitor'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '387517004', 'Paracetamol',    array['acetaminophen','crocin','dolo','calpol'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '372756006', 'Warfarin',       array['warfarin sodium'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '387475002', 'Furosemide',     array['frusemide','lasix'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '67866001',  'Insulin',        array['human insulin'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '386872004', 'Ramipril',       array['cardace'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '373567002', 'Losartan',       array['losartan potassium','cozaar'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '387137007', 'Omeprazole',     array['omez'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '372826007', 'Metoprolol',     array['metoprolol tartrate','metolar'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '386952008', 'Clopidogrel',    array['plavix','clopilet'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '386966003', 'Glimepiride',    array['amaryl'], array['MedicationRequest','AllergyIntolerance']),
  ('snomed', '256349002', 'Peanut',         array['groundnut','peanuts'], array['AllergyIntolerance']),

  -- SNOMED CT: procedures
  ('snomed', '80146002',  'Appendectomy',                         array['appendicectomy','excision of appendix'], array['Procedure']),
  ('snomed', '232717009', 'Coronary artery bypass grafting',      array['cabg','bypass surgery'], array['Procedure']),
  ('snomed', '73761001',  'Colonoscopy',                          array[]::text[], array['Procedure']),

  -- LOINC: laboratory tests
  ('loinc', '2345-7',  'Glucose [Mass/volume] in Serum or Plasma',                          array['blood glucose','glucose','blood sugar','fbs','rbs'], array['Observation','DiagnosticReport']),
  ('loinc', '4548-4',  'Hemoglobin A1c/Hemoglobin.total in Blood',                          array['hba1c','glycated hemoglobin','a1c'], array['Observation','DiagnosticReport']),
  ('loinc', '718-7',   'Hemoglobin [Mass/volume] in Blood',                                 array['hemoglobin','haemoglobin','hb'], array['Observation','DiagnosticReport']),
  ('loinc', '2160-0',  'Creatinine [Mass/volume] in Serum or Plasma',                       array['creatinine','serum creatinine'], array['Observation','DiagnosticReport']),
  ('loinc', '2951-2',  'Sodium [Moles/volume] in Serum or Plasma',                          array['sodium','serum sodium','na'], array['Observation','DiagnosticReport']),
  ('loinc', '2823-3',  'Potassium [Moles/volume] in Serum or Plasma',                       array['potassium','serum potassium'], array['Observation','DiagnosticReport']),
  ('loinc', '6690-2',  'Leukocytes [#/volume] in Blood by Automated count',                 array['white blood cell count','wbc','tlc','total leukocyte count'], array['Observation','DiagnosticReport']),
  ('loinc', '777-3',   'Platelets [#/volume] in Blood by Automated count',                  array['platelet count','platelets'], array['Observation','DiagnosticReport']),
  ('loinc', '2093-3',  'Cholesterol [Mass/volume] in Serum or Plasma',                      array['total cholesterol','cholesterol'], array['Observation','DiagnosticReport']),
  ('loinc', '13457-7', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation', array['ldl cholesterol','ldl'], array['Observation','DiagnosticReport']),
  ('loinc', '2571-8',  'Triglyceride [Mass/volume] in Serum or Plasma',                     array['triglycerides','tg'], array['Observation','DiagnosticReport']),
  ('loinc', '3094-0',  'Urea nitrogen [Mass/volume] in Serum or Plasma',                    array['blood urea nitrogen','bun','urea'], array['Observation','DiagnosticReport']),
  ('loinc', '1742-6',  'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma', array['alt','sgpt'], array['Observation','DiagnosticReport']),
  ('loinc', '1920-8',  'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma', array['ast','sgot'], array['Observation','DiagnosticReport']),
  ('loinc', '3016-3',  'Thyrotropin [Units/volume] in Serum or Plasma',                     array['tsh','thyroid stimulating hormone'], array['Observation','DiagnosticReport']),

  -- ICD-10 (WHO): secondary codes for diagnoses
  ('icd10', 'E11', 'Type 2 diabetes mellitus',                    array['type 2 diabetes','t2dm'], array['Condition']),
  ('icd10', 'I10', 'Essential (primary) hypertension',            array['hypertension','high blood pressure'], array['Condition']),
  ('icd10', 'J45', 'Asthma',                                      array[]::text[], array['Condition']),
  ('icd10', 'J44', 'Other chronic obstructive pulmonary disease', array['copd'], array['Condition']),
  ('icd10', 'I21', 'Acute myocardial infarction',                 array['heart attack'], array['Condition']),
  ('icd10', 'I50', 'Heart failure',                               array['cardiac failure'], array['Condition']),
  ('icd10', 'I48', 'Atrial fibrillation and flutter',             array['atrial fibrillation'], array['Condition']),
  ('icd10', 'J18', 'Pneumonia, organism unspecified',             array['pneumonia'], array['Condition']),
  ('icd10', 'E03', 'Other hypothyroidism',                        array['hypothyroidism'], array['Condition']),
  ('icd10', 'N18', 'Chronic kidney disease',                      array['ckd'], array['Condition'])
on conflict (system, code) do update
  set display = excluded.display, synonyms = excluded.synonyms, resource_types = excluded.resource_types;

-- Short forms and brand names, expanded before searching: the title is what the document says (any case),
-- the content is what to search for instead.
insert into public.knowledge_docs (kind, title, content)
select v.kind, v.title, v.content
  from (values
    ('abbreviation', 'HTN',   'hypertension'),
    ('abbreviation', 'T2DM',  'type 2 diabetes mellitus'),
    ('abbreviation', 'DM',    'diabetes mellitus'),
    ('abbreviation', 'MI',    'myocardial infarction'),
    ('abbreviation', 'AF',    'atrial fibrillation'),
    ('abbreviation', 'CKD',   'chronic kidney disease'),
    ('abbreviation', 'COPD',  'chronic obstructive lung disease'),
    ('abbreviation', 'CHF',   'heart failure'),
    ('abbreviation', 'HbA1c', 'hemoglobin a1c'),
    ('abbreviation', 'WBC',   'leukocytes'),
    ('drug_brand_map', 'Crocin',   'paracetamol'),
    ('drug_brand_map', 'Dolo',     'paracetamol'),
    ('drug_brand_map', 'Glycomet', 'metformin'),
    ('drug_brand_map', 'Ecosprin', 'aspirin'),
    ('drug_brand_map', 'Amlong',   'amlodipine'),
    ('drug_brand_map', 'Storvas',  'atorvastatin'),
    ('drug_brand_map', 'Lasix',    'furosemide'),
    ('drug_brand_map', 'Plavix',   'clopidogrel')
  ) as v(kind, title, content)
 where not exists (select 1 from public.knowledge_docs d where d.kind = v.kind and lower(d.title) = lower(v.title));

-- What is loaded now.
select system, count(*) as concepts from public.terminology_concepts group by system order by system;
select kind, count(*) as entries from public.knowledge_docs group by kind order by kind;
