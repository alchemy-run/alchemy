# The Spark consumer (spark.py): Iceberg's Spark runtime and AWS bundle in the image,
# checked by digest, so spark-submit resolves nothing at run time.
FROM apache/spark:3.5.5-python3@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1
ADD --chown=spark:spark --checksum=sha256:c40ae0a8e2673bb5c01951b7d15aae2224a534f8331f4274ce2082776116a044 \
  https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-spark-runtime-3.5_2.12/1.9.2/iceberg-spark-runtime-3.5_2.12-1.9.2.jar \
  /opt/spark/jars/
ADD --chown=spark:spark --checksum=sha256:ea5b6fec1b547e2fe936f804c737943f5ee322d038560f63a8261deb766def1b \
  https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-aws-bundle/1.9.2/iceberg-aws-bundle-1.9.2.jar \
  /opt/spark/jars/
COPY spark.py /consumers/spark.py
