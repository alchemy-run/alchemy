export default {
  async tail(events: any[]) {
    for (const event of events) {
      console.log(event);
    }
  },
};
