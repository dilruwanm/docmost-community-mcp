# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-09

### Fixed

- Page tools now accept a page slugId anywhere a page id is required, as the tool schemas advertise. Previously the value was passed to Docmost unchanged, and endpoints that only accept UUIDs failed with misleading errors: `list_child_pages`, `delete_page`, `restore_page` and `move_page` returned 500 Internal server error, and `export_page` returned 400 "No accessible pages to export". SlugIds are now resolved to UUIDs before the request, including for `parent_page_id` and `after_page_id`. ([#1](https://github.com/dilruwanm/docmost-community-mcp/issues/1))

## [1.0.0] - 2026-08-26

### Added

- Initial public release: MCP server for self-hosted Docmost Community Edition with page, space, comment, search, attachment, label and space-member tools.

[1.0.1]: https://github.com/dilruwanm/docmost-community-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dilruwanm/docmost-community-mcp/releases/tag/v1.0.0
