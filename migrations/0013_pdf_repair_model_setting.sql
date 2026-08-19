alter table "locus_instance_settings"
  add column "pdfRepairModel" text;

alter table "locus_instance_settings"
  add constraint "locus_instance_settings_pdf_repair_model_check"
  check (
    "pdfRepairModel" is null or (
      char_length("pdfRepairModel") between 1 and 200
      and "pdfRepairModel" = btrim("pdfRepairModel")
    )
  );
