# Third-party licenses and acknowledgements

This notice applies to Worklog **0.3.2**. Worklog's original implementation is
covered by the [root MIT license](LICENSE). Third-party components retain their
own licenses; the root license does not replace them.

## Code redistributed in the server SDK bundle

Worklog redistributes `server/vendor/paseo-sdk.cjs` so the plugin can use Paseo's
authenticated local and Connected Host transport without requiring users to
install npm dependencies in the plugin directory. This generated file contains
code from all nine packages listed below. The inventory was checked against
the files with nonzero `bytesInOutput` in
[`server/vendor/paseo-sdk.meta.json`](server/vendor/paseo-sdk.meta.json), rather
than against every package installed for development.

| Redistributed package | Version | License | Complete original license | Upstream project |
| --- | --- | --- | --- | --- |
| `@getpaseo/client` | 0.15.4 | Apache-2.0 | [Paseo LICENSE](licenses/paseo-0.15.4-LICENSE.txt) | [Paseo v0.15.4](https://github.com/getpaseo/paseo/tree/v0.15.4/packages/client) |
| `@getpaseo/protocol` | 0.15.4 | Apache-2.0 | [Paseo LICENSE](licenses/paseo-0.15.4-LICENSE.txt) | [Paseo v0.15.4](https://github.com/getpaseo/paseo/tree/v0.15.4/packages/protocol) |
| `@getpaseo/relay` | 0.15.4 | Apache-2.0 | [Paseo LICENSE](licenses/paseo-0.15.4-LICENSE.txt) | [Paseo v0.15.4](https://github.com/getpaseo/paseo/tree/v0.15.4/packages/relay) |
| `@noble/ciphers` | 2.4.0 | MIT | [noble-ciphers LICENSE](licenses/noble-ciphers-2.4.0-LICENSE.txt) | [noble-ciphers](https://github.com/paulmillr/noble-ciphers) |
| `@noble/curves` | 2.4.0 | MIT | [noble-curves LICENSE](licenses/noble-curves-2.4.0-LICENSE.txt) | [noble-curves](https://github.com/paulmillr/noble-curves) |
| `@noble/hashes` | 2.4.0 | MIT | [noble-hashes LICENSE](licenses/noble-hashes-2.4.0-LICENSE.txt) | [noble-hashes](https://github.com/paulmillr/noble-hashes) |
| `base64-js` | 1.5.1 | MIT | [base64-js LICENSE](licenses/base64-js-1.5.1-LICENSE.txt) | [base64-js](https://github.com/beatgammit/base64-js) |
| `tweetnacl` | 1.0.3 | Unlicense | [TweetNaCl.js LICENSE](licenses/tweetnacl-1.0.3-LICENSE.txt) | [TweetNaCl.js](https://github.com/dchest/tweetnacl-js) |
| `ws` | 8.22.2 | MIT | [ws LICENSE](licenses/ws-8.22.2-LICENSE.txt) | [ws](https://github.com/websockets/ws) |

The three Paseo packages share the upstream repository's license. Their npm
packages do not include that file, so the complete original was obtained from
the official [v0.15.4 LICENSE](https://github.com/getpaseo/paseo/blob/v0.15.4/LICENSE).
Its verified Git blob ID is `2f5903143b08de0aa991ab535d9582aca6b9b44a`. That file
includes Paseo's copyright and third-party-component statement as well as the
full Apache License 2.0 text. No separate `NOTICE` file was present at the
v0.15.4 repository root or the `packages/client`, `packages/protocol`, and
`packages/relay` directory roots checked for this distribution.

The remaining license files are byte-for-byte copies from the installed
packages at the exact versions shown above. Each original text includes its
permission terms and warranty disclaimer.

### Preserved attribution

The copied license texts preserve these copyright lines:

- Paseo: `Copyright (c) 2025-present Mohamed Boudra`.
- noble-ciphers: `Copyright (c) 2022 Paul Miller (https://paulmillr.com)` and
  `Copyright (c) 2016 Thomas Pornin <pornin@bolet.org>`.
- noble-curves and noble-hashes: `Copyright (c) 2022 Paul Miller (https://paulmillr.com)`.
- base64-js: `Copyright (c) 2014 Jameson Little`.
- ws: `Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>`,
  `Copyright (c) 2013 Arnout Kazemier and contributors`, and
  `Copyright (c) 2016 Luigi Pinca and contributors`.

[`licenses/BUNDLED_SOURCE_NOTICES.txt`](licenses/BUNDLED_SOURCE_NOTICES.txt)
also preserves the complete license and public-domain comment blocks found in
the emitted source inputs. These include TweetNaCl.js's 2014 port attribution
to Dmitry Chestnykh and Devi Mandiri, its attribution to Andrew Moon's
Poly1305-donna-16, and noble's source-file license comments. The noble-ciphers
source comment says 2023 while its package license says 2022; both original
texts are preserved without changing either year. TweetNaCl.js's complete
public-domain dedication and disclaimer are in its accompanying Unlicense
file. Its original [AUTHORS.md](licenses/tweetnacl-1.0.3-AUTHORS.md) is also
included.

### Changes made when producing the bundle

[`scripts/paseo-sdk-entry.ts`](scripts/paseo-sdk-entry.ts) selects
`createPaseoApi`, `createHostClient`, `createHostChannelTransport`, and
`DaemonClient` from the official SDK. The build in
[`scripts/build-paseo-sdk.mjs`](scripts/build-paseo-sdk.mjs) combines the
required modules into a CommonJS file, removes unused code, and minifies the
result for Node.js 24 using esbuild 0.25.12. It fixes `WS_NO_BUFFER_UTIL` and
`WS_NO_UTF_8_VALIDATE` to `"1"`, selecting ws's JavaScript implementation
without its optional native accelerators. These are build-time transformations;
the installed upstream module source files were not edited.

The generated file is identified as generated in its header, points to this
notice, and retains esbuild-recognized legal comments at the end of the file
(`legalComments: "eof"`). The additional source notices and full license texts
in `licenses/` accompany the bundle even when an ordinary upstream comment is
removed by minification.

## Dependencies supplied by Paseo or Node.js

Zod is an external import of the server SDK bundle. Node.js built-in modules
are also external. Their code is not copied into that bundle. Paseo supplies
the plugin runtime's React, React Native, `@getpaseo/plugin`, TanStack Query,
and Zod modules; those dependencies retain their own licenses in the host
distribution. Node.js supplies the SQLite API and its other built-in modules.

`package-lock.json` records development dependency versions. The full
`node_modules` directory, build tools such as TypeScript and esbuild, and
unrelated development dependencies are not redistributed as part of Worklog.

## Architecture references

Worklog does not copy another plugin's implementation. Its design was informed
by these public projects:

- [Paseo Tasks](https://github.com/anh-chu/paseo-plugin-tasks): task/session
  separation and structured reports.
- [Agent Inbox](https://github.com/wangfh5/paseo-agent-inbox): host-qualified
  agent identity and a read-only multi-host roster.
- [Progress](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress):
  work journals and output references.
- [Status](https://github.com/fullstackhouse/paseo-status): Now / Done / Next
  and freshness presentation.
- [Artiboard](https://github.com/yulmucoffee/artiboard): task-centric handoffs.

These acknowledgements are separate from the redistributed-code inventory
above. Paseo SDK contracts were checked against
[Paseo v0.15.4](https://github.com/getpaseo/paseo/tree/v0.15.4).

## Rebuild and license audit records

[`licenses/provenance.json`](licenses/provenance.json) records package versions,
license-file SHA-256 hashes, original sources, the current bundle and metadata
hashes, and the emitted-package inventory. Rebuilding the SDK after changing
dependencies can change the redistributed code. Refresh the package inventory,
original license files, source notices, and provenance hashes together before
redistributing such a build. Keep `licenses/` and this notice with the generated
SDK bundle.
