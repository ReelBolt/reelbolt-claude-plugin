# Design system tools: reference

## Arguments

| Tool | Arguments |
|---|---|
| `GetDesignSystem` | `kind?` (`design` or `product_map`), `projectId?` |
| `ListDesignChanges` | `kind?` (`design`, `product_map`), `projectId?` |
| `ProposeSaveDesignSystem` | `primaryColor`, `secondaryColor`, `backgroundColor`, `textColor`, `headingFont`, `bodyFont`, `tagline`, `projectId?` |
| `ApplySaveDesignSystem` | the same seven, plus `confirmationToken`, `projectId?` |
| `ProposeDecideDesignChange` | `decision` (`approve` or `reject`), `changeName`, `projectId?` |
| `ApplyDecideDesignChange` | `decision`, `changeName`, `confirmationToken`, `projectId?` |

## Details

- Colours must be `#RRGGBB`. Fonts may be a bundled font (Inter, Montserrat, Poppins, Bebas Neue,
  Anton, DejaVu Sans, Chakra Petch, JetBrains Mono, Oswald, Roboto Condensed, Archivo Black,
  Playfair Display, Permanent Marker, Bangers) or any other safe font name. The tagline is a short
  brand line. All other tokens of the current approved version are kept.
- The save token binds the normalized values and the base version.
- Saving needs Edit access to the project; reading needs View.
- `changeName` comes from `ListDesignChanges`. Two changes that would read the same get a `(#n)`
  suffix, oldest first; use the name exactly as listed.
- A rejection records the note "via assistant (MCP)" when it comes from Claude Code.
- `approve` is refused over MCP, and in the dashboard chat while the user has auto mode on or the
  account cannot be read. A brand change rides only on the user's own click on the in-app approval
  card or the Design system page.
- Design-guidance tools and targeted file read and edit tools are not covered by this plugin version.
