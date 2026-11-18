# Instructions for use maintenance

The user entrance is /help/, and the help button next to the page title opens the same set of content as in the configuration pop-up window.

- Each chapter uses an independent Markdown file, with the title consistent with index.json.
- index.json maintains chapter order, classification, routing association and search keywords.
- Second-level titles are used for chapter positioning; when modifying the title, the section and document links of the HelpButton are checked simultaneously.
- web/scripts/generate-user-guide.mjs generates front-end content files when the Next configuration is loaded; the generated results are submitted together to ensure that independent type checks are executable.
- The normal page only retains fields, units, default values, status feedback and key operation confirmations. Mechanics, examples, and troubleshooting updated here.
- The documentation is based on actual implementation descriptions and does not treat candidates, static clues, or saved configurations as validation successes.

After modification, execute front-end production build, check search, chapter deep link, help panel and narrow screen layout. When adding or modifying key operation prompts, the consequences of confirmation deletion, overwriting, and service restart are still displayed at the operation location.
