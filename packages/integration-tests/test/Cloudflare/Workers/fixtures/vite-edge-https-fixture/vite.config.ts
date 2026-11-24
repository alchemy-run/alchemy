import { defineConfig } from "vite";

// A throwaway self-signed certificate (CN=localhost) so the dev server
// serves HTTPS. It protects nothing; it only exists to exercise the local
// edge's HTTPS limitation.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC83ZY4K52DBxE9
tbdvqs146XyuEphYrebSYirQog6DdEJecSDA/ZB1m6o6ImOgHmUTh28bb8qv03JI
KwX0iCDaENhDjB+SAO7K3JAxJ2hRA9FKC5Mzl5FoSrmPaEGV/zpX8RuWTP3uh5Pj
aCT13d3bh4+Nx/rMJPq+s0UtdZh6yKSvkP1aaS1ZbSbNszggCZ/wsWj2eqz42RfQ
7nx0t/UG4BmDYTduJKTnIZZ/B2ubwr5eBFBOzOu8Axcr9zf6sVl52o1pmazq1tt6
+QeH4P4EJtYKxvgsf4S3Mi/y8nXDn5GmlAqdRWfK/5AXghi+v2tL1he+5w2XHY6Y
uHESjhCdAgMBAAECggEAYjWbqsPLWVowdfVrWM7pn8lSQzZ6MArl71qKxwiuIV8w
L+oFzTVNjEqQ/z/orFeB2eDgPtUoAbwjPjHZG+o5owuFWcKgnAyOH8EH3fePACnL
CATy264iN6g7y7279SLOFPLUlJiepw2rMmJybcOcXU6lsGVgHg3QsZ+JBnWS/602
qIvBcIS8rjtGV17ecWq+txoql9JQeDdDLrR374PF9WamQUkeBadT1ldg62DGJft2
k0m8TMvWuWUaqj3X4FFwxgIlpS9LE0MfE7Z4Nt7ooap/07Y6n6vwO99kQwhDMuXQ
o5gjd7Ftq4/QrdPpDoTcdQVKJIGrvpf2OEQEyQMWBQKBgQDviY2mGGpVt1moViE0
Ydy0DTNiXKAewqfUPLWlrVrKNeV3KMUXodk+QksSFaXNaSc3VR+8s9BXOfKIn7OA
2NbwbinnLTBrGDmwj/nVnCPCBjRzvTM2ZiAUexyIqGLNkjgZJ1ZpLXUXWydI0tt4
YkIOXSMXb2GKFaCxH1CJbMXfcwKBgQDJ2IJStgQui/QqM1pK1XnlPeCGXUzwGoFg
Qog4dPW/H6PC0EgpJvI69t/aRnAgihwXJ0yHt65oIhfbpeYlQZ5tOfjIIoxGojpa
UdTZw/ZjmSSTP9Ze1e0EWXGyTPQa7AI0mdPFil6JDfm0bVa3DyebUAarDSt5NmKq
Mic2JbYrrwKBgQCZQA7w6gP2DRT+fwRFaCr0wtFSJ+KFa5JGVgT9F3jTkEHbx6i5
IuJDU9SFoHXwgksFup9QclZjx/4kbNBCKfjx3/lNHvswOVKHZMW5ZWj3NFMQjUab
kiEKGW26/Mghr1/Wr/U3205jf/0VOVoSngKW//14e9kSqB2j1F4JXh8GgwKBgEXZ
NagXsrTE27aq1Kkm3KrW0dbNfK1uDq1X+LnIx63e7hWhbAdJofODsQ1g6LZp9LSS
depVRvZkLetlqpHj9kYIFK51PiPHSfgtb0H4jVAEE+Mc6TsiPoYNycmQ1bxnRZAc
V2t5qaM2Ad5NI//vL56Qf+47fXrRtiz9dBJJ1JOjAoGABJkLRf2Q3zfzpxEmdPWk
3uJjHaPFEH/t1//fyIwrOosGKLuSGBKOs2xXub2mOtYTr4qA9CJANYe5nmZ2GJDi
qAqQ4hp2/C0uNHUvURn+MlW0CcDKz6MTatx6PcrUAf7/QF74tTAGAepkU8TRhgI1
mNipnmtFdrq15E0pgq42UZI=
-----END PRIVATE KEY-----
`;
const cert = `-----BEGIN CERTIFICATE-----
MIICpjCCAY4CCQC7XM3a8pamGjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwIBcNMjYxMTI0MTIzMjA2WhgPMjEyNjEwMzExMjMyMDZaMBQxEjAQ
BgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALzdljgrnYMHET21t2+qzXjpfK4SmFit5tJiKtCiDoN0Ql5xIMD9kHWbqjoiY6Ae
ZROHbxtvyq/TckgrBfSIINoQ2EOMH5IA7srckDEnaFED0UoLkzOXkWhKuY9oQZX/
OlfxG5ZM/e6Hk+NoJPXd3duHj43H+swk+r6zRS11mHrIpK+Q/VppLVltJs2zOCAJ
n/CxaPZ6rPjZF9DufHS39QbgGYNhN24kpOchln8Ha5vCvl4EUE7M67wDFyv3N/qx
WXnajWmZrOrW23r5B4fg/gQm1grG+Cx/hLcyL/LydcOfkaaUCp1FZ8r/kBeCGL6/
a0vWF77nDZcdjpi4cRKOEJ0CAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAk89ovJZL
mIj7BseWXGry+jlaeb7FAnL8EpLUxl6otC1aloJEjej2a5IOfiLr+viMF8xVU9iP
OhmqDDRjeL+myX/qq+vdpYW4Cpg9BOWmEzptdHePnFMS5S+o4kUsbfLlbUaHNjVl
TU6cmH6jRCBQ3uCUc1If54xuSOlnIh0ZYeWDHAaUNUNKqyCFMFdtBeXy4HRmRSgu
tS/YR+U8IM2VYZP02w8+YkiF0rIBgTvCEmfgxkln0tjQ7FpBKT1jgeDVftAkKCvo
ENH8T4Xx/NnEtv83p8fgLr/lPfJDoEhHt4QVeAviOffYYAx1AC64qAX+YxFtr5n5
A9tElLyUohw5Pw==
-----END CERTIFICATE-----
`;

export default defineConfig({
  server: { https: { key, cert } },
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "./src/worker.ts",
        },
      },
    },
  },
});
