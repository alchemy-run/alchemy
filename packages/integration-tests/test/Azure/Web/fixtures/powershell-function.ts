/**
 * A PowerShell Functions package with one HTTP-triggered function
 * (`HttpTrigger`, `authLevel: function`), generated once with Python's
 * zipfile from:
 *
 *   host.json                 { "version": "2.0", extensionBundle [4.*, 5.0.0), managedDependency off }
 *   profile.ps1               (empty)
 *   HttpTrigger/function.json httpTrigger (GET) in, http out
 *   HttpTrigger/run.ps1       Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{ StatusCode = 200; Body = "ok" })
 *
 * PowerShell needs no package install, so the zip deploys without a build.
 */
export const FUNCTION_ZIP_BASE64 =
  "UEsDBBQAAAAIAAAAIVy/6+4ZhgAAALUAAAAJAAAAaG9zdC5qc29uXc2xCgIxEATQPl8xbKccyyHaXKeonV9gFS97Ejg3cklEPfLvEjtth5l5swHoIVP0QakDrbilpmbyTKI13WV1o1CH2QAAeVd7J99PIYYh8fadJ+Fj1j75oJEPf8P69muc17xssOGW2wUZoHzBm1V7FbeXu6gT7V+VBInayyjVHOwYBcUU8wFQSwMEFAAAAAgAAAAhXAAAAAACAAAAAAAAAAsAAABwcm9maWxlLnBzMQMAUEsDBBQAAAAIAAAAIVxc9bo5iAAAAOsAAAAZAAAASHR0cFRyaWdnZXIvZnVuY3Rpb24uanNvbl3OMQ7CMAwF0D2n+PLcE/QMTIgNdSjEJJFoUhIHCUW5O2oqFGDx4OdvuyiALs5r502iEWcFAKVVgOYs9sBPvtMIumV/FRc8DR+W18qbWJH1FJ0xHDtqF3mfH0HuK+XnpaWO/MicpMPCYoNub5BhoalB3b38nqPh70LIsvX68rQGn5hQFTCpqt5QSwMEFAAAAAgAAAAhXBI2Lj58AAAAhQAAABMAAABIdHRwVHJpZ2dlci9ydW4ucHMxNci9CsIwFAbQvU/xUTq0YKC4SkHaxcUfqriIw4VcatAmMbkXFPHdnTzjiZRorquRn8pZFqhOyU0Tpy0LWRJqioPmm9mrRJXeeev8BLOjmTFyjsFnhjnTQxn1ZSMS/zsEL/yS6/qDo5BoHoJldFi27Qp9sG90KMO9xLcpflBLAQIUAxQAAAAIAAAAIVy/6+4ZhgAAALUAAAAJAAAAAAAAAAAAAACkAQAAAABob3N0Lmpzb25QSwECFAMUAAAACAAAACFcAAAAAAIAAAAAAAAACwAAAAAAAAAAAAAApAGtAAAAcHJvZmlsZS5wczFQSwECFAMUAAAACAAAACFcXPW6OYgAAADrAAAAGQAAAAAAAAAAAAAApAHYAAAASHR0cFRyaWdnZXIvZnVuY3Rpb24uanNvblBLAQIUAxQAAAAIAAAAIVwSNi4+fAAAAIUAAAATAAAAAAAAAAAAAACkAZcBAABIdHRwVHJpZ2dlci9ydW4ucHMxUEsFBgAAAAAEAAQA+AAAAEQCAAAAAA==";

/** Name of the function in the package. */
export const FUNCTION_NAME = "HttpTrigger";
