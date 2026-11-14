## MODIFIED Requirements

### Requirement: A file that repeatedly fails unexpectedly is retained for inspection
A file whose processing fails with an unexpected error (not a validation
rejection) more than the configured maximum receive count SHALL be moved to a
dead-letter destination rather than discarded, and SHALL remain available for
inspection and reprocessing. The dead-letter destination SHALL retain each
message for 14 days, counted from the message's original enqueue time. The
file's upload object SHALL still exist for as long as its dead-letter message
can, so a redrive within that window finds the object.

#### Scenario: Persistently failing file lands in the dead-letter destination
- **WHEN** a file's processing raises an unexpected error on every retry up to
  the configured maximum
- **THEN** the file's message is present in the dead-letter destination and no
  `statement_files`, `raw_rows`, or `transactions` rows were written for it

#### Scenario: Dead-lettered file can be reprocessed for the whole retention window
- **WHEN** a dead-lettered message is redriven 13 days after its file was
  uploaded, with the default upload retention
- **THEN** the worker can still read the file's upload object and process it
