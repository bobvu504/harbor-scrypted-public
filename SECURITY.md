# Security policy

## No security warranty

This project is open-source software provided as is. Project Monitor Inc. may
review code and reports on a best-effort basis, but does not promise that every
change or release has been reviewed. No review is a certification, guarantee,
endorsement, or representation that the project is secure or free of
vulnerabilities. We do not vouch for its security or fitness for any purpose.

Users and downstream distributors are responsible for evaluating the software,
its dependencies, and their own deployment. Do not use this project for
safety-critical or security-critical purposes.

## Supported versions

No versions are currently supported. If releases are published, this section
will identify which versions are eligible for best-effort security fixes.

## Deployment boundary

Treat camera video, credentials, tokens, URLs, logs, and configuration as
sensitive. Keep the camera and Scrypted host on a trusted local network. Do not
port-forward camera, Scrypted, RTSP, WebRTC, or management services to the
internet. Use network segmentation, unique credentials, least privilege, and
current software throughout the deployment.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use this repository's
GitHub **Security → Report a vulnerability** flow. Include affected versions,
reproduction steps, impact, and any suggested mitigation, while omitting real
credentials, private video, and other personal data.

Reports and fixes are handled on a best-effort basis. Submission does not
create a support obligation, response-time commitment, or guarantee of a fix.
