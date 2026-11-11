// NetApp Volumes refuses every call from a billing account it hasn't
// accepted, even with the API and billing enabled: `Forbidden: Read access
// to project '…' was denied: please check billing account associated and
// retry`. Set GCP_TEST_NETAPP=1 on a project whose billing account NetApp
// accepts (GCP_TEST_NETAPP_VOLUMES implies it).
export const entitled = !!process.env.GCP_TEST_NETAPP || !!process.env.GCP_TEST_NETAPP_VOLUMES;

/** The tag a read of a missing NetApp resource fails with on this project. */
export const missingTag = entitled ? "NotFound" : "Forbidden";
