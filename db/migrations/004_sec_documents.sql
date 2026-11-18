-- The documents inside each selected SEC filing (from the filing's index page on www.sec.gov/Archives).
-- The documents themselves stay in the on-disk cache (data/cache/www.sec.gov/); this table says which exist.
create table if not exists raw.sec_document (
  accession    text not null,
  cik          integer not null,
  kind         text not null,          -- annual | earnings | deal | merger (why the filing was selected)
  seq          integer,
  description  text,
  filename     text not null,
  doc_type     text,                   -- 10-K, EX-99.1, EX-101.INS, XML (extracted inline-XBRL instance), ...
  size_bytes   bigint,
  url          text not null,
  primary key (accession, filename)
);
create index if not exists sec_document_cik on raw.sec_document (cik, kind);
create index if not exists sec_document_type on raw.sec_document (doc_type);

-- Filings whose index page has been read (so a re-run does not fetch them again).
create table if not exists raw.sec_document_index (
  accession   text primary key,
  cik         integer not null,
  kind        text not null,
  n_documents integer not null,
  read_at     timestamptz not null default now()
);
