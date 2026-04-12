import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: "check-vite-environments",
    async buildApp(builder) {
      const environments = Object.values(builder.environments).map(
        (environment) => ({
          name: environment.name,
          outDir: environment.config.build.outDir,
          assetsDir: environment.config.build.assetsDir,
        }),
      );
      console.log("HELLO PEAR, THE ENVIRONMENTS ARE:", environments);
    },
  },{
    name: "check-client-outdir",
    applyToEnvironment(environment) {
      return environment.name === "client";
    },
    generateBundle(outputOptions) {
      console.log(
        "HAY PEAR THE OUTDIR WE'RE DETECTING FOR CLIENT ASSETS IS:",
        outputOptions.dir,
      );
    },
  },],
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
  },
});
